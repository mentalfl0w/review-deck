import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReviewDeckAgentPanel } from "./client/ReviewDeckAgentPanel";
import { ReviewDeckPanel } from "./client/ReviewDeckPanel";
import { ReviewDeckSettings } from "./client/ReviewDeckSettings";
import { ReviewBatchTimelineItem, type ReviewBatchTimelineItemProps } from "./client/components/ReviewBatchTimelineItem";
import { ReviewHandoffTimelineItem } from "./client/components/ReviewHandoffTimelineItem";
import { getAgentRegistry } from "./client/agent-registry";
import { getReviewCountStore } from "./client/review-count-store";
import { registerReviewEntries } from "./client/review-entries";
import { getProjectReviewCommentCount } from "./shared/review";
import {
  reviewBatchTimelineKind,
  reviewBatchTimelineSchema,
  reviewBatchTimelineVersion,
} from "./shared/review-batch";
import {
  reviewHandoffTimelineKind,
  reviewHandoffTimelineSchema,
  reviewHandoffTimelineVersion,
} from "./shared/review-handoff";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "review-deck",
    title: "Review Deck",
    icon: "ScanSearch",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ReviewDeckPanel,
  });
  client.addWorkspacePanel({
    id: "review-deck-agent",
    title: "Review Deck",
    icon: "ScanSearch",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: ReviewDeckAgentPanel,
  });
  client.addCommandCenterItem({
    id: "open-review-deck",
    title: "Open Review Deck",
    icon: "ScanSearch",
    keywords: ["review", "diff", "risk", "hunk"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("review-deck");
    },
  });
  client.addCommandCenterItem({
    id: "open-review-deck-for-agent",
    title: "Open Review Deck for this Agent",
    icon: "ScanSearch",
    keywords: ["review", "diff", "risk", "hunk"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("review-deck-agent");
    },
  });
  client.addSlashCommand({
    name: "review-deck",
    description: "Open Review Deck for this Agent workspace",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel("review-deck-agent");
    },
  });
  client.addTimelineRenderer({
    kind: reviewHandoffTimelineKind,
    version: reviewHandoffTimelineVersion,
    schema: reviewHandoffTimelineSchema,
    Component: ReviewHandoffTimelineItem,
  });
  // Version-1 rows for one ReviewBatch. Timeline item props expose no
  // navigation, so the contribution captures client.openPanel here and hands
  // the renderer a callback bound to the agent that owns the timeline; the
  // callback only ever receives the schema-validated workspace id.
  client.addTimelineRenderer({
    kind: reviewBatchTimelineKind,
    version: reviewBatchTimelineVersion,
    schema: reviewBatchTimelineSchema,
    Component: function ReviewBatchTimelineRow(props: Omit<ReviewBatchTimelineItemProps, "onOpenReviewDeck">) {
      return (
        <ReviewBatchTimelineItem
          {...props}
          onOpenReviewDeck={(workspaceId) =>
            client.openPanel("review-deck-agent", {
              workspaceId,
              agentId: props.agentId,
              location: "workspace",
            })}
        />
      );
    },
  });
  client.addSettingsScreen({
    id: "review-defaults",
    title: "Review defaults",
    icon: "SlidersHorizontal",
    Component: ReviewDeckSettings,
  });

  // One shared agent registry for every consumer (panel hooks and the entry
  // points below): the panel hooks acquire the same instance and never open a
  // second agent subscription of their own.
  const registry = getAgentRegistry();
  registry.bind(client.paseo);

  // The badge path is the count-only RPC: no badge ever asks for a diff.
  const counts = getReviewCountStore();
  counts.bindFetcher(async (projectId) =>
    (await client.rpc(getProjectReviewCommentCount, { projectId })).commentCount);

  const entries = registerReviewEntries({
    client: {
      addHeaderButton: (contribution) => client.addHeaderButton(contribution),
      addComposerPill: (contribution) => client.addComposerPill(contribution),
      openPanel: (id, options) => client.openPanel(id, options),
    },
    paseo: client.paseo,
    registry,
    counts,
  });

  // Plugin reload: drop every button/pill registration, detach the count RPC
  // and release the shared subscriptions, including a bootstrap still in
  // flight.
  return () => {
    entries.stop();
    counts.bindFetcher(null);
    registry.stop();
  };
}
