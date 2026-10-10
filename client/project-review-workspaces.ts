import type { ProjectReviewComment } from "../shared/review";
import type { ActiveReviewBatch } from "../shared/review-batch";
import type { AgentEntry, ProjectReviewWorkspaceGroup } from "./tools";
import { isAgentIdleForReviewDispatch } from "./agent-registry";

function normalizeWorkspaceCwd(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}
export type WorkspaceDirectoryOwner = { workspaceId: string; directory: string };

/** Whether the currently selected workspace Agent can receive this queue batch. */
export function canSubmitProjectReviewGroup(group: ProjectReviewWorkspaceGroup): boolean {
  if (!group.workspaceId || group.activeBatch || !group.selectedAgentId) return false;
  const agent = group.eligibleAgents.find((candidate) => candidate.id === group.selectedAgentId);
  if (!agent?.cwd) return false;
  return isAgentIdleForReviewDispatch(agent.status);
}

/** Group project comments by recorded workspace. Legacy rows without a
 * workspaceId are assigned only when the full project workspace list proves
 * their cwd has exactly one owner; eligible Agents are not ownership proof. */
export function groupProjectReviewComments(input: {
  comments: readonly ProjectReviewComment[];
  batches: readonly ActiveReviewBatch[];
  agents: readonly AgentEntry[];
  workspaceDirectoryOwners: readonly WorkspaceDirectoryOwner[];
  selectedAgentByWorkspace: Readonly<Record<string, string>>;
  preferredAgentId?: string | null;
}): ProjectReviewWorkspaceGroup[] {
  const groups = new Map<string, Omit<ProjectReviewWorkspaceGroup, "eligibleAgents" | "selectedAgentId" | "activeBatch">>();

  for (const comment of input.comments) {
    let workspaceId = comment.workspaceId ?? null;
    if (!workspaceId) {
      const matchingWorkspaceIds = new Set(input.workspaceDirectoryOwners
        .filter((workspace) => normalizeWorkspaceCwd(workspace.directory) === normalizeWorkspaceCwd(comment.cwd))
        .map((workspace) => workspace.workspaceId));
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
      ? input.agents.filter((agent) => agent.workspaceId === group.workspaceId && !agent.archived)
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
