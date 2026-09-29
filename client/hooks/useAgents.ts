import { useEffect, useMemo, useSyncExternalStore } from "react";
import { usePaseo } from "@getpaseo/plugin/client";
import {
  USABLE_AGENT_STATUSES,
  getAgentRegistry,
  selectWorkspaceAgents,
} from "../agent-registry";
import type { AgentEntry, AgentInfo } from "../tools";

/**
 * Agent registry views for the panel: the shared owned subscription's local
 * copy (one subscription for the whole plugin, shared with the composer-pill
 * registrations) filtered exactly as before — statuses that can accept review
 * actions, then the strict workspace scope. The panel is strictly bound to its
 * incoming workspaceId; the scope below can never admit an agent of a sibling
 * workspace.
 *
 * `agentRevision` is the registry's mutation counter: it changes only when the
 * agent set actually moved, so the snapshot watcher can treat it as a
 * workspace-activity signal without polling.
 */
export function useAgents(params: { selectedWorkspaceId: string; reviewCwd: string | null }) {
  const { selectedWorkspaceId, reviewCwd } = params;
  const paseo = usePaseo();
  const registry = getAgentRegistry();
  useEffect(() => {
    registry.bind(paseo);
  }, [paseo, registry]);
  const snapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);

  const allAgents = useMemo(() => snapshot.agents
    .filter((agent) => USABLE_AGENT_STATUSES[agent.status] === true)
    .map((agent): AgentEntry => ({
      id: agent.id,
      workspaceId: agent.workspaceId,
      cwd: agent.cwd,
      status: agent.status,
      provider: agent.provider,
      model: agent.model,
      title: agent.title,
    })),
  [snapshot.agents]);

  const workspaceScoped = useMemo(
    () => selectWorkspaceAgents(allAgents, { selectedWorkspaceId, reviewCwd }),
    [allAgents, reviewCwd, selectedWorkspaceId],
  );

  // Workspace-scoped agents for the single-hunk flows.
  const agents = useMemo(() => workspaceScoped
    .map(({ id, provider, model, title }): AgentInfo => ({ id, provider, model, title })),
  [workspaceScoped]);
  // Project-scoped processing agents for the batch queue (same safe scope).
  const projectAgents = agents;

  return { agents, projectAgents, agentsLoading: snapshot.loading, agentRevision: snapshot.revision };
}
