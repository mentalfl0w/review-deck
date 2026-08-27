import { useCallback, useEffect, useMemo, useState } from "react";
import { usePaseo } from "@getpaseo/plugin";
import type { AgentEntry, AgentInfo } from "../tools.client";

/**
 * Agent registry: loads the workspace's agent list once and derives the two
 * filtered views — workspace-scoped agents for single-hunk flows and
 * project-scoped processing agents for the batch queue.
 */
export function useAgents(params: { selectedWorkspaceId: string; reviewCwd: string | null }) {
  const { selectedWorkspaceId, reviewCwd } = params;
  const paseo = usePaseo();
  const [allAgents, setAllAgents] = useState<AgentEntry[]>([]);

  const loadAgents = useCallback(async () => {
    try {
      const result = await paseo.agents.list();
      const matching = result.entries.filter((agent: AgentEntry) =>
        (!agent.status || agent.status === "idle" || agent.status === "running"),
      );
      setAllAgents(matching.map((agent: AgentEntry) => ({
        id: agent.id,
        workspaceId: agent.workspaceId,
        cwd: agent.cwd,
        status: agent.status,
        provider: agent.provider,
        model: agent.model,
        title: agent.title,
      })));
    } catch {
      setAllAgents([]);
    }
  }, [paseo.agents]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // Workspace-scoped agents for the single-hunk flows (unchanged semantics).
  const agents = useMemo(() => allAgents
    .filter((agent) => agent.workspaceId === selectedWorkspaceId || agent.cwd === reviewCwd)
    .map(({ id, provider, model, title }): AgentInfo => ({ id, provider, model, title })),
  [allAgents, reviewCwd, selectedWorkspaceId]);
  // Project-scoped processing agents: ONLY idle/running agents of the currently
  // selected workspace (the top workspace selector). Exact workspaceId match
  // wins; agents without a workspace id are admitted only when their cwd is
  // exactly the selected workspace directory. Agents of sibling workspaces
  // that share this project must never appear here.
  const projectAgents = useMemo(() => allAgents
    .filter((agent) => {
      if (agent.workspaceId) return agent.workspaceId === selectedWorkspaceId;
      const cwd = agent.cwd ?? "";
      if (!cwd || !reviewCwd) return false;
      const trim = (value: string) => {
        let out = value;
        while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) out = out.slice(0, -1);
        return out;
      };
      return trim(cwd) === trim(reviewCwd);
    })
    .map(({ id, provider, model, title }): AgentInfo => ({ id, provider, model, title })),
  [allAgents, reviewCwd, selectedWorkspaceId]);

  return { agents, projectAgents };
}
