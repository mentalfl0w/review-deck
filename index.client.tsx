import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReviewDeckAgentPanel } from "./client/ReviewDeckAgentPanel";
import { ReviewDeckPanel } from "./client/ReviewDeckPanel";
import { ReviewDeckSettings } from "./client/ReviewDeckSettings";
import { ReviewHandoffTimelineItem } from "./client/components/ReviewHandoffTimelineItem";
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
  client.addSettingsScreen({
    id: "review-defaults",
    title: "Review defaults",
    icon: "SlidersHorizontal",
    Component: ReviewDeckSettings,
  });
  return () => {};
}
