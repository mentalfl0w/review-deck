import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin";
import {
  listProjectReviewComments,
  processProjectReview,
  type ProcessProjectReviewResult,
  type ProjectReviewComment,
  type ProjectReviewSummary,
  type ReviewScope,
} from "../../review.shared";
import type { AgentInfo } from "../tools.client";
import type { TFunc } from "../i18n.client";

/**
 * Project comment queue: the saved project comments list, the batch
 * process/delete flow with its run guards, the processing agent selection and
 * the queue modal visibility. Resets on project or workspace switch.
 */
export function useProjectComments(params: {
  effectiveProjectId: string;
  selectedWorkspaceId: string;
  reviewCwd: string | null;
  projectAgents: AgentInfo[];
  t: TFunc;
}) {
  const { effectiveProjectId, selectedWorkspaceId, reviewCwd, projectAgents, t } = params;
  const listProjectCommentsRpc = useRpc(listProjectReviewComments);
  const processProjectCommentsRpc = useRpc(processProjectReview);
  const [selectedProcessAgent, setSelectedProcessAgent] = useState("");
  const [projectComments, setProjectComments] = useState<ProjectReviewSummary | null>(null);
  const [projectCommentsLoading, setProjectCommentsLoading] = useState(false);
  const [projectCommentsError, setProjectCommentsError] = useState<string | null>(null);
  const [processingProject, setProcessingProject] = useState(false);
  const [processResult, setProcessResult] = useState<ProcessProjectReviewResult | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const projectRunRef = useRef(0);
  const projectCommentsRequestRef = useRef(0);

  const projectAgentOptions = useMemo(() => projectAgents.map((agent) => ({
    value: agent.id,
    label: `${agent.title ?? agent.id} · ${agent.provider ?? "?"} / ${agent.model ?? t("noAgentModel")}`,
  })), [projectAgents, t]);
  useEffect(() => {
    setSelectedProcessAgent((current) =>
      projectAgents.some((agent) => agent.id === current) ? current : (projectAgents[0]?.id ?? ""));
  }, [projectAgents]);

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
      if (requestId !== projectCommentsRequestRef.current) return;
      setProjectComments(result.project);
    } catch (error) {
      if (requestId !== projectCommentsRequestRef.current) return;
      setProjectCommentsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === projectCommentsRequestRef.current) setProjectCommentsLoading(false);
    }
  }, [effectiveProjectId, listProjectCommentsRpc]);

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

  const processProject = useCallback(async () => {
    if (!effectiveProjectId || !selectedProcessAgent) return;
    // The loaded comments must belong to the current project and must be fully
    // loaded; never process another project's list or a still-loading one.
    if (projectComments === null || projectCommentsLoading || projectComments.projectId !== effectiveProjectId) return;
    if (projectComments.commentCount === 0) return;
    if (!reviewCwd) return;
    // The agent must belong to the currently selected workspace; a stale
    // selection (workspace switched underneath the dropdown) is refused here,
    // and the server re-validates the same binding before any run.
    if (!projectAgents.some((agent) => agent.id === selectedProcessAgent)) {
      setProcessError(t("processProjectAgentMismatch"));
      return;
    }
    const run = projectRunRef.current + 1;
    projectRunRef.current = run;
    setProcessingProject(true);
    setProcessError(null);
    setProjectNotice(null);
    setProcessResult(null);
    try {
      const result = await processProjectCommentsRpc({
        projectId: effectiveProjectId,
        agentId: selectedProcessAgent,
        workspaceId: selectedWorkspaceId,
        workspaceCwd: reviewCwd,
      });
      // A project switch or a newer run superseded this one; drop the stale result.
      if (run !== projectRunRef.current) return;
      setProcessResult(result);
      void refreshProjectComments();
    } catch (error) {
      if (run !== projectRunRef.current) return;
      setProcessError(error instanceof Error ? error.message : String(error));
    } finally {
      // Only the run that started the indicator may clear it: a superseded run
      // must not stop the newer run's spinner.
      if (run === projectRunRef.current) setProcessingProject(false);
    }
  }, [effectiveProjectId, processProjectCommentsRpc, projectAgents, projectComments, projectCommentsLoading, refreshProjectComments, reviewCwd, selectedProcessAgent, selectedWorkspaceId, t]);

  const openProjectQueue = useCallback(() => {
    setQueueOpen(true);
    void refreshProjectComments();
  }, [refreshProjectComments]);

  const canProcessProject = Boolean(effectiveProjectId) &&
    projectComments !== null &&
    projectComments.projectId === effectiveProjectId &&
    !projectCommentsLoading &&
    projectComments.commentCount > 0 &&
    projectAgents.length > 0 &&
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
    selectedProcessAgent,
    setSelectedProcessAgent,
    queueOpen,
    setQueueOpen,
    refreshProjectComments,
    processProject,
    openProjectQueue,
    canProcessProject,
    commentsByTarget,
    projectAgentOptions,
  };
}
