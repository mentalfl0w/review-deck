import { useCallback, useEffect, useMemo, useState } from "react";
import { usePaseo } from "@getpaseo/plugin/client";
import type { AgentEntry, AgentInfo } from "../tools";

/** Statuses an agent must be in to accept review actions. */
const USABLE_STATUSES: Record<string, true> = {
  idle: true,
  running: true,
  initializing: true,
};

/** Normalize a cwd for comparison: strip trailing separators (both platforms). */
function normalizeCwd(value: string | null | undefined): string | null {
  if (!value) return null;
  let out = value;
  while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) out = out.slice(0, -1);
  return out;
}

/**
 * Agent registry: loads the daemon's agent list once and derives the two
 * filtered views — workspace-scoped agents for single-hunk flows and
 * project-scoped processing agents for the batch queue. The panel is strictly
 * bound to its incoming workspaceId; the scope below can never admit an agent
 * of a sibling workspace.
 *
 * fetch_agents entries wrap each agent snapshot with its project context
 * ({ agent, project }); the flat fields live on `entry.agent`.
 */
export function useAgents(params: { selectedWorkspaceId: string; reviewCwd: string | null }) {
  const { selectedWorkspaceId, reviewCwd } = params;
  const paseo = usePaseo();
  const [allAgents, setAllAgents] = useState<AgentEntry[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);

  const loadAgents = useCallback(async () => {
    // The registry may still be warming up when the panel mounts; retry a
    // couple of times before settling so the UI never reports "no agents"
    // while the host is still loading.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await paseo.agents.list();
        const eligible = result.entries
          .filter((entry) => {
            const status = entry.agent.status;
            return !!status && USABLE_STATUSES[status] === true;
          })
          .map((entry): AgentEntry => ({
            id: entry.agent.id,
            workspaceId: entry.agent.workspaceId ?? null,
            cwd: entry.agent.cwd,
            status: entry.agent.status,
            provider: entry.agent.provider,
            model: entry.agent.model,
            title: entry.agent.title,
          }));
        setAllAgents(eligible);
        setAgentsLoading(false);
        return;
      } catch {
        if (attempt < 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    }
    // Registry unreachable: settle as empty so the panel stops reporting a
    // loading state; the empty view is only ever rendered after a settled
    // result, never while the registry is still loading.
    setAllAgents([]);
    setAgentsLoading(false);
  }, [paseo.agents]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // Workspace-scoped agents: exact workspaceId match wins; agents without a
  // workspace id are admitted only when their (normalized) cwd is exactly the
  // bound workspace directory. Agents of sibling workspaces that share this
  // directory must never appear here.
  const workspaceScoped = useMemo(() => allAgents
    .filter((agent) => {
      if (agent.workspaceId) return agent.workspaceId === selectedWorkspaceId;
      const cwd = normalizeCwd(agent.cwd);
      const review = normalizeCwd(reviewCwd);
      return !!cwd && !!review && cwd === review;
    }),
  [allAgents, reviewCwd, selectedWorkspaceId]);

  // Workspace-scoped agents for the single-hunk flows.
  const agents = useMemo(() => workspaceScoped
    .map(({ id, provider, model, title }): AgentInfo => ({ id, provider, model, title })),
  [workspaceScoped]);
  // Project-scoped processing agents for the batch queue (same safe scope).
  const projectAgents = agents;

  return { agents, projectAgents, agentsLoading };
}
