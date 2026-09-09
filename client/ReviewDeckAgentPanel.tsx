import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ReviewDeckPanel } from "./ReviewDeckPanel";

/** Agent-context Review Deck: renders the existing Review Deck bound to the
 * workspace that hosts this agent, with the agent preselected as the review
 * target. The agentId is a preferred, validated selection only: it applies
 * once the Agent registry settles and solely when the workspace-scoped agent
 * list admits it — otherwise no agent is selected. Mounting the panel never
 * runs a review, sends a prompt, or touches Git; apart from the initial
 * target, behavior is identical to the workspace panel. */
export function ReviewDeckAgentPanel({ theme, layout, workspaceId, agentId }: PluginAgentPanelProps) {
  return (
    <ReviewDeckPanel
      theme={theme}
      layout={layout}
      workspaceId={workspaceId}
      preferredAgentId={agentId}
    />
  );
}
