import { useEffect, useState } from "react";

import type {
  PluginButtonContentProps,
  PluginClientContext,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { ReviewDeckPanel } from "./client/ReviewDeckPanel";
import {
  clearReviewPanelLaunches,
  consumeReviewPanelLaunch,
  getReviewPanelLaunch,
  openReviewPanelInWorkspace,
  useReviewPanelLaunch,
  type ReviewPanelLaunchRequest,
} from "./client/review-panel-launch";
import { ReviewDeckSettings } from "./client/ReviewDeckSettings";
import { ReviewAiReviewTimelineItem, type ReviewAiReviewTimelineItemProps } from "./client/components/ReviewAiReviewTimelineItem";
import { ReviewBatchTimelineItem, type ReviewBatchTimelineItemProps } from "./client/components/ReviewBatchTimelineItem";
import { ReviewHeaderPopover } from "./client/components/ReviewHeaderPopover";
import { ReviewPillMenu } from "./client/components/ReviewPillMenu";
import { ReviewHandoffTimelineItem } from "./client/components/ReviewHandoffTimelineItem";
import { groupProjectReviewComments, type WorkspaceDirectoryOwner } from "./client/project-review-workspaces";
import { getAgentRegistry, isAgentIdleForReviewDispatch } from "./client/agent-registry";
import { getReviewCountStore } from "./client/review-count-store";
import { getReviewEntryStatusStore } from "./client/review-entry-status-store";
import { registerReviewEntries } from "./client/review-entries";
import { getProjectReviewCommentCount, listProjectReviewComments, processProjectReview } from "./shared/review";
import {
  reviewAiTimelineKind,
  reviewAiTimelineSchema,
  reviewAiTimelineVersion,
  getWorkspaceReviewIndicators,
} from "./shared/review-activity";
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

function WorkspaceReviewDeckPanel(props: PluginWorkspacePanelProps) {
  const pendingLaunch = useReviewPanelLaunch(props.workspaceId);
  const [launch, setLaunch] = useState<ReviewPanelLaunchRequest | null>(() =>
    getReviewPanelLaunch(props.workspaceId),
  );

  useEffect(() => {
    if (!pendingLaunch) return;
    setLaunch(pendingLaunch);
    consumeReviewPanelLaunch(props.workspaceId, pendingLaunch.requestId);
  }, [pendingLaunch, props.workspaceId]);

  return <ReviewDeckPanel {...props} launchRequest={launch} />;
}
export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "review-deck",
    title: "Review Deck",
    icon: "ScanSearch",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspaceReviewDeckPanel,
  });
  client.addCommandCenterItem({
    id: "open-review-deck",
    title: "Open Review Deck",
    icon: "ScanSearch",
    keywords: ["review", "diff", "risk", "hunk"],
    context: "workspace",
    onSelect({ workspace, openPanel }) {
      openReviewPanelInWorkspace({ workspaceId: workspace.id, action: "deck" }, openPanel);
    },
  });
  client.addCommandCenterItem({
    id: "open-review-deck-for-agent",
    title: "Open Review Deck for this Agent",
    icon: "ScanSearch",
    keywords: ["review", "diff", "risk", "hunk"],
    context: "agent",
    onSelect({ workspace, agent, openPanel }) {
      openReviewPanelInWorkspace({
        workspaceId: workspace.id,
        action: "deck",
        preferredAgentId: agent.id,
      }, openPanel);
    },
  });
  client.addSlashCommand({
    name: "review-deck",
    description: "Open Review Deck for this Agent workspace",
    argumentHint: "",
    context: "agent",
    onSubmit({ workspace, agent, openPanel }) {
      openReviewPanelInWorkspace({
        workspaceId: workspace.id,
        action: "deck",
        preferredAgentId: agent.id,
      }, openPanel);
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
      const { workspaceId, status, completedAt } = props.item.data;
      useEffect(() => {
        void getReviewEntryStatusStore().refresh(workspaceId);
      }, [completedAt, status, workspaceId]);
      return (
        <ReviewBatchTimelineItem
          {...props}
          onOpenReviewDeck={(workspaceId) =>
            openReviewPanelInWorkspace({
              workspaceId,
              action: "deck",
              preferredAgentId: props.agentId,
            }, (id, options) => client.openPanel(id, { workspaceId, ...options }))}
        />
      );
    },
  });
  client.addTimelineRenderer({
    kind: reviewAiTimelineKind,
    version: reviewAiTimelineVersion,
    schema: reviewAiTimelineSchema,
    Component: function ReviewAiReviewTimelineRow(props: Omit<ReviewAiReviewTimelineItemProps, "onOpenReviewDeck">) {
      return (
        <ReviewAiReviewTimelineItem
          {...props}
          onOpenReviewDeck={(workspaceId) =>
            openReviewPanelInWorkspace({
              workspaceId,
              action: "deck",
              preferredAgentId: props.agentId,
            }, (id, options) => client.openPanel(id, { workspaceId, ...options }))}
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

  // The badge still uses the count-only project RPC; v1.7 status metadata never
  // asks the server to parse a diff until the user opens the popover.
  const counts = getReviewCountStore();
  counts.bindFetcher(async (projectId) =>
    (await client.rpc(getProjectReviewCommentCount, { projectId })).commentCount);
  const statuses = getReviewEntryStatusStore();
  statuses.bindFetcher(async (workspaceId) => {
    const result = await client.rpc(getWorkspaceReviewIndicators, { workspaceId });
    counts.setCount(result.projectId, result.projectPendingCommentCount + result.projectStaleCommentCount);
    return result;
  });

  const submitPendingComments = async ({ workspaceId, agentId }: { workspaceId: string; agentId: string }) => {
    const indicators = await client.rpc(getWorkspaceReviewIndicators, { workspaceId });
    statuses.setStatus(workspaceId, indicators);
    counts.setCount(indicators.projectId, indicators.projectPendingCommentCount + indicators.projectStaleCommentCount);
    const workspace = await client.paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace || workspace.archivingAt || workspace.projectId && workspace.projectId !== indicators.projectId) {
      throw new Error("The workspace is unavailable or its project changed. Refresh Review Deck and retry.");
    }
    const result = await client.rpc(listProjectReviewComments, { projectId: indicators.projectId });
    if (!result.project) return;
    if (indicators.workspacePendingCommentCount + indicators.workspaceStaleCommentCount === 0) return;
    let workspaceDirectoryOwners: WorkspaceDirectoryOwner[] = [];
    if (result.project.comments.some((comment) => comment.workspaceId === undefined)) {
      const workspaceList = await client.paseo.workspaces.list({ filter: { projectId: indicators.projectId } });
      if (workspaceList.pageInfo.hasMore) {
        throw new Error("Cannot prove unique workspace ownership for legacy comments in this project.");
      }
      workspaceDirectoryOwners = workspaceList.entries.flatMap((entry) =>
        entry.workspaceDirectory ? [{ workspaceId: entry.id, directory: entry.workspaceDirectory }] : []);
    }
    const agentEntries = registry.getSnapshot().agents;
    const groups = groupProjectReviewComments({
      comments: result.project.comments,
      batches: result.project.batches,
      agents: agentEntries,
      workspaceDirectoryOwners,
      selectedAgentByWorkspace: {},
      preferredAgentId: agentId,
    });
    const group = groups.find((candidate) => candidate.workspaceId === workspaceId);
    if (!group || group.comments.length === 0) return;
    if (group.activeBatch) throw new Error("This workspace already has an active ReviewBatch.");
    const agent = group.eligibleAgents.find((candidate) => candidate.id === agentId);
    if (!agent || agent.archived || group.selectedAgentId !== agentId || !isAgentIdleForReviewDispatch(agent.status)) {
      throw new Error("The selected Agent is no longer eligible in this workspace.");
    }
    if (!agent.cwd) throw new Error("The selected Agent has no workspace directory.");
    await client.rpc(processProjectReview, {
      projectId: indicators.projectId,
      agentId,
      workspaceId,
      workspaceCwd: agent.cwd,
      commentIds: group.comments.map((comment) => comment.id),
    });
  };

  const entries = registerReviewEntries({
    client: {
      addHeaderButton: (contribution) => client.addHeaderButton(contribution),
      addComposerPill: (contribution) => client.addComposerPill(contribution),
      openReviewPanel: (input) =>
        openReviewPanelInWorkspace(input, (id, options) =>
          client.openPanel(id, { workspaceId: input.workspaceId, ...options })),
      createHeaderPopover: (workspaceId) => function ReviewHeaderPopoverContent(props: PluginButtonContentProps) {
        if (props.context !== "workspace" || props.workspaceId !== workspaceId) return null;
        return (
          <ReviewHeaderPopover
            {...props}
            onOpenReviewDeck={() => {
              props.close();
              openReviewPanelInWorkspace({ workspaceId, action: "deck" }, (id, options) =>
                client.openPanel(id, { workspaceId, ...options }));
            }}
            onOpenQueue={() => {
              props.close();
              openReviewPanelInWorkspace({ workspaceId, action: "queue" }, (id, options) =>
                client.openPanel(id, { workspaceId, ...options }));
            }}
          />
        );
      },
      createPillMenu: (actions) => function ReviewPillMenuContent(props: PluginButtonContentProps) {
        return <ReviewPillMenu {...props} actions={actions} />;
      },
    },
    paseo: client.paseo,
    registry,
    counts,
    statuses,
    submitPendingComments,
  });

  // Plugin reload: drop every button/pill registration, detach both RPC caches
  // and release the shared subscriptions, including a bootstrap still in flight.
  return () => {
    entries.stop();
    statuses.bindFetcher(null);
    counts.bindFetcher(null);
    clearReviewPanelLaunches();
    registry.stop();
  };
}
