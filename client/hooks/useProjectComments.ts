import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import {
  listProjectReviewComments,
  processProjectReview,
  type ProcessProjectReviewResult,
  type ProjectReviewComment,
  type ProjectReviewSummary,
  type ReviewScope,
} from "../../shared/review";
import type { AgentEntry } from "../tools";
import { groupProjectReviewComments } from "../project-review-workspaces";
import { getReviewCountStore } from "../review-count-store";
import { getReviewEntryStatusStore } from "../review-entry-status-store";
import type { TFunc } from "../i18n";


/**
 * Project queue: saved comments, per-workspace Agent selection, batch
 * submission results, and the queue modal. Project changes reset all state;
 * workspace changes reset only results for the prior workspace context.
 */
export function useProjectComments(params: {
  effectiveProjectId: string;
  selectedWorkspaceId: string;
  projectAgents: AgentEntry[];
  /** Agent-context panels prefer their hosting Agent for that Agent's workspace. */
  preferredAgentId?: string | null;
  t: TFunc;
}) {
  const { effectiveProjectId, selectedWorkspaceId, projectAgents, preferredAgentId, t } = params;
  const listProjectCommentsRpc = useRpc(listProjectReviewComments);
  const processProjectCommentsRpc = useRpc(processProjectReview);
  const [selectedProcessAgentsByWorkspace, setSelectedProcessAgentsByWorkspace] = useState<Record<string, string>>({});
  const [projectComments, setProjectComments] = useState<ProjectReviewSummary | null>(null);
  const [projectCommentsLoading, setProjectCommentsLoading] = useState(false);
  const [projectCommentsError, setProjectCommentsError] = useState<string | null>(null);
  const [processingProject, setProcessingProject] = useState(false);
  const [processResult, setProcessResult] = useState<ProcessProjectReviewResult[] | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const projectRunRef = useRef(0);
  const projectCommentsRequestRef = useRef(0);

  const selectWorkspaceAgent = useCallback((groupKey: string, agentId: string) => {
    setSelectedProcessAgentsByWorkspace((current) => ({ ...current, [groupKey]: agentId }));
  }, []);

  const refreshProjectComments = useCallback(async (projectId: string = effectiveProjectId) => {
    // Bind this request to the project it was started for; a project switch or
    // a newer refresh supersedes it, so stale success/failure never lands.
    const requestId = ++projectCommentsRequestRef.current;
    if (!projectId) {
      setProjectComments(null);
      setProjectCommentsLoading(false);
      setProjectCommentsError(null);
      return;
    }
    setProjectCommentsLoading(true);
    setProjectCommentsError(null);
    try {
      const result = await listProjectCommentsRpc({ projectId });
      // The entry badges read the same project-scoped count the queue shows;
      // publishing it here keeps review/header pills in sync with every local
      // comment change without another round trip. A superseded response is
      // still this project's own count, so it lands before the staleness guard
      // drops it from the panel.
      getReviewCountStore().setCount(projectId, result.project?.commentCount ?? 0);
      if (requestId !== projectCommentsRequestRef.current) return;
      setProjectComments(result.project);
      void getReviewEntryStatusStore().refresh(selectedWorkspaceId);
    } catch (error) {
      if (requestId !== projectCommentsRequestRef.current) return;
      setProjectCommentsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === projectCommentsRequestRef.current) setProjectCommentsLoading(false);
    }
  }, [effectiveProjectId, listProjectCommentsRpc, selectedWorkspaceId]);

  useEffect(() => {
    // Processing results, notices and loaded comments belong to one project:
    // drop them immediately on switch so project A's comments are never shown
    // while project B loads (the card shows the loading state instead).
    // Invalidate the previous project's request token BEFORE starting the
    // refresh: React runs effects in declaration order, and a cleanup effect
    // declared after the refresh would supersede the fresh token and drop the
    // just-started request. Merging them guarantees the invalidation wins and
    // the refresh (whose own `++projectCommentsRequestRef` binds to the newest
    // token) actually lands.
    projectRunRef.current += 1;
    projectCommentsRequestRef.current += 1;
    setSelectedProcessAgentsByWorkspace({});
    setProcessResult(null);
    setProcessError(null);
    setProjectNotice(null);
    setProcessingProject(false);
    setProjectComments(null);
    setProjectCommentsError(null);
    setProjectCommentsLoading(false);
    void refreshProjectComments();
  }, [effectiveProjectId, refreshProjectComments]);
  // A workspace switch must never carry the previous workspace's batch run
  // state into the new context: results, errors, notices and in-flight flags
  // belong to the run they were produced in. The project queue itself survives
  // (it is the project's single entry and groups every workspace's comments by
  // target); a stale run of another workspace is refused by the agent binding
  // check in processProject and re-validated on the server.
  useEffect(() => {
    projectRunRef.current += 1;
    setProcessResult(null);
    setProcessError(null);
    setProjectNotice(null);
    setProcessingProject(false);
  }, [selectedWorkspaceId]);

  const workspaceGroups = useMemo(
    () => groupProjectReviewComments({
      comments: projectComments?.comments ?? [],
      batches: projectComments?.batches ?? [],
      agents: projectAgents,
      selectedAgentByWorkspace: selectedProcessAgentsByWorkspace,
      preferredAgentId,
    }),
    [preferredAgentId, projectAgents, projectComments, selectedProcessAgentsByWorkspace],
  );

  const processProject = useCallback(async () => {
    if (!effectiveProjectId) return;
    if (projectComments === null || projectCommentsLoading || projectComments.projectId !== effectiveProjectId) return;
    if (projectComments.commentCount === 0) return;

    const assignments = workspaceGroups.flatMap((group) => {
      if (!group.workspaceId || group.activeBatch || !group.selectedAgentId) return [];
      const agent = group.eligibleAgents.find((candidate) => candidate.id === group.selectedAgentId);
      if (!agent?.cwd) return [];
      return [{ group, agent }];
    });
    if (assignments.length === 0) return;

    const run = projectRunRef.current + 1;
    projectRunRef.current = run;
    setProcessingProject(true);
    setProcessError(null);
    setProjectNotice(null);
    setProcessResult(null);
    try {
      const settled = await Promise.allSettled(assignments.map(({ group, agent }) =>
        processProjectCommentsRpc({
          projectId: effectiveProjectId,
          agentId: agent.id,
          workspaceId: group.workspaceId!,
          workspaceCwd: agent.cwd!,
          commentIds: group.comments.map((comment) => comment.id),
        }),
      ));
      if (run !== projectRunRef.current) return;
      const submitted: ProcessProjectReviewResult[] = [];
      const failures: string[] = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") submitted.push(result.value);
        else failures.push(`${assignments[index]!.group.cwd}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      });
      setProcessResult(submitted.length > 0 ? submitted : null);
      setProcessError(failures.length > 0 ? failures.join("\n") : null);
      const pendingWorkspaceCount = workspaceGroups.filter((group) =>
        !group.activeBatch && (!group.workspaceId || !group.selectedAgentId),
      ).length;
      setProjectNotice(
        pendingWorkspaceCount > 0
          ? t("processProjectWorkspacesPending", { count: pendingWorkspaceCount })
          : null,
      );
      void refreshProjectComments();
    } finally {
      if (run === projectRunRef.current) setProcessingProject(false);
    }
  }, [effectiveProjectId, processProjectCommentsRpc, projectComments, projectCommentsLoading, refreshProjectComments, t, workspaceGroups]);

  const openProjectQueue = useCallback(() => {
    setQueueOpen(true);
    void refreshProjectComments();
  }, [refreshProjectComments]);

  const canProcessProject = Boolean(effectiveProjectId) &&
    projectComments !== null &&
    projectComments.projectId === effectiveProjectId &&
    !projectCommentsLoading &&
    projectComments.commentCount > 0 &&
    workspaceGroups.some((group) =>
      Boolean(group.workspaceId && group.selectedAgentId && !group.activeBatch),
    ) &&
    !processingProject;
  const commentsByTarget = useMemo(() => {
    const targets = new Map<string, {
      cwd: string;
      scope: ReviewScope;
      targetFingerprint: string;
      files: Map<string, { filePath: string; comments: ProjectReviewComment[] }>;
    }>();
    for (const comment of projectComments?.comments ?? []) {
      const targetKey = `${comment.cwd}\u0000${comment.scope}\u0000${comment.targetFingerprint}`;
      const target = targets.get(targetKey) ?? {
        cwd: comment.cwd,
        scope: comment.scope,
        targetFingerprint: comment.targetFingerprint,
        files: new Map<string, { filePath: string; comments: ProjectReviewComment[] }>(),
      };
      const file = target.files.get(comment.filePath) ?? { filePath: comment.filePath, comments: [] };
      file.comments.push(comment);
      target.files.set(comment.filePath, file);
      targets.set(targetKey, target);
    }
    return Array.from(targets.values(), (target) => ({
      ...target,
      files: Array.from(target.files.values()),
    }));
  }, [projectComments]);

  return {
    projectComments,
    projectCommentsLoading,
    projectCommentsError,
    processingProject,
    processResult,
    processError,
    projectNotice,
    workspaceGroups,
    selectWorkspaceAgent,
    queueOpen,
    setQueueOpen,
    refreshProjectComments,
    processProject,
    openProjectQueue,
    canProcessProject,
    commentsByTarget,
  };
}
