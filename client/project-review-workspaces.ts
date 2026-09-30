import type { ProjectReviewComment } from "../shared/review";
import type { ActiveReviewBatch } from "../shared/review-batch";
import type { AgentEntry, ProjectReviewWorkspaceGroup } from "./tools";

function normalizeWorkspaceCwd(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

/** Group project comments by their recorded workspace, resolving legacy rows
 * without workspaceId only when exactly one project Agent owns the same cwd. */
export function groupProjectReviewComments(input: {
  comments: readonly ProjectReviewComment[];
  batches: readonly ActiveReviewBatch[];
  agents: readonly AgentEntry[];
  selectedAgentByWorkspace: Readonly<Record<string, string>>;
  preferredAgentId?: string | null;
}): ProjectReviewWorkspaceGroup[] {
  const groups = new Map<string, Omit<ProjectReviewWorkspaceGroup, "eligibleAgents" | "selectedAgentId" | "activeBatch">>();

  for (const comment of input.comments) {
    let workspaceId = comment.workspaceId ?? null;
    if (!workspaceId) {
      const matchingWorkspaceIds = new Set(input.agents
        .filter((agent) => normalizeWorkspaceCwd(agent.cwd) === normalizeWorkspaceCwd(comment.cwd))
        .map((agent) => agent.workspaceId)
        .filter((id): id is string => id !== null));
      if (matchingWorkspaceIds.size === 1) workspaceId = [...matchingWorkspaceIds][0] ?? null;
    }

    const normalizedCwd = normalizeWorkspaceCwd(comment.cwd) ?? comment.cwd;
    const key = workspaceId ? `workspace:${workspaceId}` : `cwd:${normalizedCwd}`;
    const group = groups.get(key) ?? { key, workspaceId, cwd: comment.cwd, comments: [] };
    group.comments.push(comment);
    groups.set(key, group);
  }

  for (const batch of input.batches) {
    const key = `workspace:${batch.workspaceId}`;
    if (groups.has(key)) continue;
    const agent = input.agents.find((candidate) => candidate.id === batch.agentId);
    groups.set(key, {
      key,
      workspaceId: batch.workspaceId,
      cwd: agent?.cwd ?? "",
      comments: [],
    });
  }

  return Array.from(groups.values(), (group) => {
    const eligibleAgents = group.workspaceId
      ? input.agents.filter((agent) => agent.workspaceId === group.workspaceId)
      : [];
    const activeBatch = input.batches.find((batch) => batch.workspaceId === group.workspaceId) ?? null;
    const storedSelection = input.selectedAgentByWorkspace[group.key];
    const selectedAgentId = storedSelection && eligibleAgents.some((agent) => agent.id === storedSelection)
      ? storedSelection
      : input.preferredAgentId && eligibleAgents.some((agent) => agent.id === input.preferredAgentId)
        ? input.preferredAgentId
        : eligibleAgents.length === 1
          ? eligibleAgents[0]!.id
          : "";
    return { ...group, eligibleAgents, selectedAgentId, activeBatch };
  });
}
