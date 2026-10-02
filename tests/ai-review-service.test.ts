import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { ReviewService } from "../server/ReviewService";
import { ReviewRunStore, type ReviewRun } from "../server/persistence/ReviewRunStore";
import { AiReviewCacheStore } from "../server/persistence/AiReviewCacheStore";
import { ReviewBatchStore } from "../server/persistence/ReviewBatchStore";
import { StateStore } from "../server/persistence/StateStore";
import type { ReviewRequest } from "../shared/review";
import type { ReviewDeckSettingsHandle } from "../shared/review-settings";

function reviewInput(cwd: string, reviewMode: "file" | "target", filePath?: string): ReviewRequest & {
  workspaceId: string;
  agentId: string;
  reviewMode: "file" | "target";
} {
  return {
    cwd,
    scope: "working",
    locale: "en",
    workspaceId: "workspace-1",
    agentId: "parent-agent",
    reviewMode,
    ...(filePath ? { filePath } : {}),
  };
}

const RESPONSE = [
  "### Verified Facts",
  "- The reviewed snapshot contains the selected change.",
  "### AI Inference",
  "- The change needs human review.",
  "### Human Verification Recommended",
  "- Verify behavior in the application.",
].join("\n");
const USAGE = {
  inputTokens: 18_400,
  outputTokens: 2_100,
  cachedInputTokens: 6_200,
  contextWindowUsedTokens: 24_700,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}


async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "review-deck-ai-review-"));
  let cachePath: string | undefined;
  let runStorePath: string | undefined;
  const activityPaths: string[] = [];
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Review Deck Test");
    git(root, "config", "user.email", "review-deck-test@example.invalid");
    await writeFile(join(root, "a.ts"), "export const stable = 1;\n");
    await writeFile(join(root, "b.ts"), "export const unrelated = 1;\n");
    git(root, "add", "a.ts", "b.ts");
    git(root, "commit", "-qm", "baseline");
    await writeFile(join(root, "a.ts"), "export const stable = 1;\nexport const AI_REVIEW_PATCH_SENTINEL = 2;\n");

    let currentSettings = {
      locale: "auto",
      diffMode: "auto",
      reviewerStrategy: "custom",
      reviewerProvider: "review-provider",
      reviewerModel: "review-model",
      reviewerThinkingOptionId: "deep",
      aiReviewCacheEnabled: true,
      showAiReviewUsage: true,
      defaultReviewPreset: "balanced",
    };
    const settings = {
      read: async () => ({ status: "ready", revision: 1, values: currentSettings }),
    };
    let providerEntries = [{
      provider: "review-provider",
      label: "Review Provider",
      enabled: true,
      status: "ready",
      models: [{
        provider: "review-provider",
        id: "review-model",
        label: "Review Model",
        isSelectable: true,
        defaultThinkingOptionId: "balanced",
        thinkingOptions: [{ id: "balanced", label: "Balanced" }, { id: "deep", label: "Deep" }],
      }],
      modes: [{ id: "plan", label: "Plan", description: "Read-only review" }],
    }];
    let parentWorkspaceId = "workspace-1";
    let parentAvailableModes: Array<{ id: string; label: string; description?: string }> = [];
    let parentProvider = "parent-provider";
    const created: Array<{
      config: Record<string, unknown>;
      prompt: string;
      cwd: string;
      parent: string;
      outputSchema?: Record<string, unknown>;
      labels?: Record<string, string>;
      idempotencyKey?: string;
      autoArchive?: boolean;
    }> = [];
    const responseQueue: string[] = [];
    const waitStatusQueue: Array<"idle" | "error" | "permission" | "timeout"> = [];
    const timelineAppends: Array<{
      agentId: string;
      item: { id?: string; kind: string; version: number; data: Record<string, unknown> };
    }> = [];
    let failNextTimelineAppend = false;
    let workspaceRecord: {
      id: string;
      projectId: string;
      workspaceDirectory: string;
      archivingAt?: string | null;
    } | null = { id: "workspace-1", projectId: "project-1", workspaceDirectory: root };
    let workspaceListEntries: Array<{ id: string; workspaceDirectory?: string }> = [
      { id: "workspace-1", workspaceDirectory: root },
    ];
    let failWorkspaceList = false;
    let workspaceListPageHasMore = false;
    const parentAgent = () => ({
      id: "parent-agent",
      workspaceId: parentWorkspaceId,
      cwd: root,
      provider: parentProvider,
      model: "parent-model",
      thinkingOptionId: "parent-thinking",
      availableModes: parentAvailableModes,
    });
    type FakeAgentSnapshot = {
      id: string;
      workspaceId: string;
      cwd: string;
      archivedAt: string | null;
      labels: Record<string, string>;
    };
    const children = new Map<string, {
      agent: FakeAgentSnapshot;
      handle: {
        id: string;
        current: () => FakeAgentSnapshot;
        refresh: () => Promise<{ agent: FakeAgentSnapshot; project: null }>;
        waitForFinish: () => Promise<{
          status: "idle" | "error" | "permission" | "timeout";
          error: string | null;
          lastMessage: string | null;
          final: { lastUsage: typeof USAGE };
        }>;
        timeline: { refetch: () => Promise<{ entries: never[] }> };
        archive: () => Promise<{ archivedAt: string }>;
      };
    }>();
    const context = {
      paseo: {
        agents: {
          ref: (agentId: string) => {
            if (agentId === "parent-agent") {
              return {
                id: agentId,
                current: parentAgent,
                refresh: async () => ({ agent: parentAgent() }),
                timeline: {
                  append: async (item: { id?: string; kind: string; version: number; data: Record<string, unknown> }) => {
                    if (failNextTimelineAppend) {
                      failNextTimelineAppend = false;
                      throw new Error("simulated timeline append failure");
                    }
                    timelineAppends.push({ agentId, item });
                    return { seq: timelineAppends.length, epoch: "epoch-1" };
                  },
                },
              };
            }
            return children.get(agentId)?.handle;
          },
          list: async (options: { filter?: { labels?: Record<string, string>; includeArchived?: boolean } }) => {
            const expectedLabels = options.filter?.labels ?? {};
            return {
              entries: [...children.values()]
                .filter(({ agent }) =>
                  Object.entries(expectedLabels).every(([key, value]) => agent.labels[key] === value),
                )
                .filter(({ agent }) => options.filter?.includeArchived === true || agent.archivedAt === null)
                .map(({ agent }) => ({ agent })),
            };
          },
          create: async (options: {
            config: Record<string, unknown>;
            prompt: string;
            cwd: string;
            parent: string;
            outputSchema?: Record<string, unknown>;
            labels?: Record<string, string>;
            idempotencyKey?: string;
            autoArchive?: boolean;
          }) => {
            const id = `review-child-${created.length + 1}`;
            created.push(options);
            const agent: FakeAgentSnapshot = {
              id,
              workspaceId: "workspace-1",
              cwd: options.cwd,
              archivedAt: null,
              labels: { ...options.labels, "paseo.parent-agent-id": options.parent },
            };
            const handle = {
              id,
              current: () => agent,
              refresh: async () => ({ agent, project: null }),
              waitForFinish: async () => ({
                status: waitStatusQueue.shift() ?? ("idle" as const),
                error: null,
                lastMessage: responseQueue.shift() ?? RESPONSE,
                final: { lastUsage: USAGE },
              }),
              timeline: { refetch: async () => ({ entries: [] as never[] }) },
              archive: async () => {
                const archivedAt = new Date().toISOString();
                agent.archivedAt = archivedAt;
                return { archivedAt };
              },
            };
            children.set(id, { agent, handle });
            return handle;
          },
        },
        workspaces: {
          ref: (workspaceId: string) => ({
            current: () => workspaceRecord,
            refresh: async () => workspaceRecord,
          }),
          list: async () => {
            if (failWorkspaceList) throw new Error("simulated workspace list failure");
            return {
              requestId: "workspace-list-request",
              entries: workspaceListEntries,
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: workspaceListPageHasMore },
            };
          },
        },
        providers: {
          snapshot: async () => ({ entries: providerEntries }),
        },
      },
    } as unknown as PluginHandlerContext;
    const cacheFilePath = join(tmpdir(), `review-deck-ai-cache-${randomUUID()}.json`);
    cachePath = cacheFilePath;
    const cacheStore = new AiReviewCacheStore({ storagePath: cacheFilePath, now: () => new Date("2026-09-30T12:00:00.000Z") });
    const runsFilePath = join(tmpdir(), `review-deck-ai-runs-${randomUUID()}.json`);
    runStorePath = runsFilePath;
    const runStore = new ReviewRunStore(runsFilePath);
    const createService = () => new ReviewService({
      settings: settings as unknown as ReviewDeckSettingsHandle,
      aiReviewCacheStore: cacheStore,
      reviewRunStore: runStore,
    });
    const service = createService();
    const pollWith = (targetService: ReviewService, requestId: string) => targetService.pollAiReview({
      requestId,
      workspaceId: "workspace-1",
      agentId: "parent-agent",
    }, context);
    const poll = (requestId: string) => pollWith(service, requestId);

    const before = await service.createSnapshot({ cwd: root, scope: "working", filePath: "a.ts", locale: "en" });
    const oldHunkId = before.files.find((file) => file.path === "a.ts")?.hunks[0]?.id;
    assert.ok(oldHunkId, "the real Git worktree produces a hunk for the selected file");

    const hunkStart = await service.startExplainHunkAi({
      cwd: root,
      scope: "working",
      locale: "en",
      filePath: "a.ts",
      hunkId: oldHunkId,
      workspaceId: "workspace-1",
      agentId: "parent-agent",
    }, context);
    const freshHunk = await poll(hunkStart.requestId);
    assert.equal(freshHunk.status, "idle");
    assert.equal(freshHunk.mode, "hunk");
    assert.equal(freshHunk.resultSource, "fresh");
    assert.equal(freshHunk.usage?.cachedTokens, 6_200);
    assert.ok(created[0].prompt.includes("AI_REVIEW_PATCH_SENTINEL"), "hunk review includes the exact selected patch");
    assert.equal(created[0]?.outputSchema, undefined, "unknown providers use the Markdown-only fallback");
    assert.ok(created[0].prompt.includes("only when the host supplies that schema"));
    assert.equal(freshHunk.sections.verifiedFacts[0], "The reviewed snapshot contains the selected change.");


    const fileInput = reviewInput(root, "file", "a.ts");
    const fileStart = await service.startRunReview(fileInput, context);
    const freshFile = await poll(fileStart.requestId);
    assert.equal(freshFile.mode, "file");
    assert.equal(freshFile.resultSource, "fresh");
    assert.ok(!created[1].prompt.includes("AI_REVIEW_PATCH_SENTINEL"), "targeted file review sends an index, not patch text");
    assert.ok(created[1].prompt.includes("a.ts"));
    assert.ok(!created[1].prompt.includes("b.ts"));

    const targetInput = reviewInput(root, "target");
    const targetStart = await service.startRunReview(targetInput, context);
    const freshTarget = await poll(targetStart.requestId);
    assert.equal(freshTarget.mode, "target");
    assert.equal(freshTarget.depth, "targeted");
    assert.equal(freshTarget.resultSource, "fresh");
    assert.equal(freshTarget.reviewPreset, "balanced");
    assert.equal(freshTarget.thinkingOptionId, "deep", "the selected thinking option is available to the result UI");
    assert.deepEqual(freshTarget.usage, {
      inputTokens: 18_400,
      outputTokens: 2_100,
      cachedTokens: 6_200,
      contextTokens: 24_700,
    });
    assert.ok(!created[2].prompt.includes("AI_REVIEW_PATCH_SENTINEL"), "targeted target review omits all patch bodies");
    assert.ok(created[2].prompt.includes("b.ts") === false, "the target index lists only current changes");
    assert.equal(created[2].config.provider, "review-provider/review-model");
    assert.equal(created[2].config.thinkingOptionId, "deep");
    assert.equal(created[2].config.modeId, "plan");
    const cachedTargetStart = await service.startRunReview(targetInput, context);
    const cachedRunRecord = await runStore.get(cachedTargetStart.requestId);
    assert.equal(cachedRunRecord?.resultSource, "cached");
    assert.equal(cachedRunRecord?.childAgentId, null);
    assert.equal(cachedRunRecord?.status, "completed");
    const cachedTarget = await pollWith(createService(), cachedTargetStart.requestId);
    assert.equal(cachedTarget.resultSource, "cached", "an unchanged target reuses its successful review");
    assert.equal(created.length, 3);


    await writeFile(join(root, "b.ts"), "export const unrelated = 1;\nexport const UNRELATED_PATCH_SENTINEL = 2;\n");
    const afterUnrelatedChange = await service.createSnapshot({ cwd: root, scope: "working", filePath: "a.ts", locale: "en" });
    const newHunkId = afterUnrelatedChange.files.find((file) => file.path === "a.ts")?.hunks[0]?.id;
    assert.ok(newHunkId && newHunkId !== oldHunkId, "the target-bound hunk ID changes when another file changes");

    const hunkCacheStart = await service.startExplainHunkAi({
      cwd: root,
      scope: "working",
      locale: "en",
      filePath: "a.ts",
      hunkId: newHunkId,
      workspaceId: "workspace-1",
      agentId: "parent-agent",
    }, context);
    const cachedHunk = await poll(hunkCacheStart.requestId);
    assert.equal(cachedHunk.resultSource, "cached", "unrelated file changes do not invalidate the hunk cache");
    assert.equal(created.length, 3);

    const fileCacheStart = await service.startRunReview(fileInput, context);
    const cachedFile = await poll(fileCacheStart.requestId);
    assert.equal(cachedFile.resultSource, "cached", "unrelated file changes do not invalidate the file cache");
    assert.equal(created.length, 3);

    const changedTargetStart = await service.startRunReview(targetInput, context);
    const changedTarget = await poll(changedTargetStart.requestId);
    assert.equal(changedTarget.resultSource, "fresh", "a changed targeted-risk index gets a fresh target review");
    assert.equal(created.length, 4);
    assert.ok(!created[3].prompt.includes("AI_REVIEW_PATCH_SENTINEL"));
    assert.ok(created[3].prompt.includes("b.ts"));

    const fullTargetStart = await service.startRunReview({ ...targetInput, reviewDepthOverride: "full" }, context);
    const fullTarget = await poll(fullTargetStart.requestId);
    assert.equal(fullTarget.depth, "full");
    assert.equal(fullTarget.reviewPreset, "balanced", "per-run Full overrides do not replace budget coverage");
    assert.equal(fullTarget.resultSource, "fresh");
    assert.ok(created[4].prompt.includes("AI_REVIEW_PATCH_SENTINEL"), "explicit Full depth includes patch bodies");

    assert.equal(await service.clearAiReviewCache(), true);
    responseQueue.push(JSON.stringify({
      summary: "Structured summary",
      findings: [{
        hunkId: newHunkId,
        filePath: "a.ts",
        severity: "high",
        evidenceKind: "verified_fact",
        category: "structured-output",
        summary: "Structured finding",
        detail: "The structured result was validated and normalized.",
        suggestedCheck: "Run the focused integration test.",
      }],
    }));
    const afterClearStart = await service.startRunReview(fileInput, context);
    const afterClear = await poll(afterClearStart.requestId);
    assert.equal(afterClear.resultSource, "fresh", "clearing the cache forces a new reviewer run");
    assert.equal(created.length, 6);
    assert.equal(afterClear.sections.summary, "Structured summary");
    assert.equal(afterClear.sections.verifiedFacts.length, 1);
    assert.ok(afterClear.review.includes("Structured finding"));
    currentSettings = { ...currentSettings, aiReviewCacheEnabled: false };
    const uncachedFirstStart = await service.startRunReview(fileInput, context);
    assert.equal((await poll(uncachedFirstStart.requestId)).resultSource, "fresh");
    const uncachedSecondStart = await service.startRunReview(fileInput, context);
    assert.equal((await poll(uncachedSecondStart.requestId)).resultSource, "fresh");
    assert.equal(created.length, 8, "disabling the cache starts a new reviewer on every request");

    currentSettings = { ...currentSettings, aiReviewCacheEnabled: true };

    currentSettings = { ...currentSettings, reviewerProvider: "unavailable-provider" };
    await assert.rejects(
      () => service.startRunReview(targetInput, context),
      /unavailable.*no fallback/i,
      "a missing custom model fails explicitly instead of falling back to the workspace Agent",
    );
    assert.equal(created.length, 8);

    currentSettings = { ...currentSettings, reviewerProvider: "review-provider" };
    providerEntries = [{ ...providerEntries[0], modes: [{ id: "build", label: "Build", description: "Writable build mode" }] }];
    await assert.rejects(
      () => service.startRunReview(targetInput, context),
      /no read-only\/plan or approval-gated Ask mode/i,
      "a provider without a read-only mode never starts a writable reviewer",
    );
    assert.equal(created.length, 8);
    providerEntries = [{ ...providerEntries[0], modes: [{ id: "ask", label: "Always Ask", description: "Write and exec tools require explicit approval" }] }];
    const askModeStart = await service.startRunReview(targetInput, context);
    const askModeResult = await poll(askModeStart.requestId);
    assert.equal(askModeResult.reviewerPermissionMode, "ask");
    assert.equal(created.length, 9);
    assert.equal(created[8].config.modeId, "ask", "the OMP fallback must use Always Ask, never Write or Full");

    currentSettings = { ...currentSettings, reviewerStrategy: "inherit" };
    parentAvailableModes = [{ id: "read-only", label: "Read-only", description: "Read-only review mode" }];
    const inheritedStart = await service.startRunReview(targetInput, context);
    const inheritedResult = await poll(inheritedStart.requestId);
    assert.equal(inheritedResult.reviewerPermissionMode, "read-only");
    assert.equal(created.length, 10);
    assert.equal(created[9].config.provider, "parent-provider/parent-model");
    assert.equal(created[9].config.thinkingOptionId, "parent-thinking");
    assert.equal(created[9].config.modeId, "read-only");
    parentProvider = "review-provider";
    parentAvailableModes = [{ id: "ask", label: "Always Ask", description: "Write and exec tools require explicit approval" }];
    providerEntries = [{ ...providerEntries[0], modes: [{ id: "plan", label: "Plan", description: "Read-only review" }] }];
    const inheritedAskStart = await service.startRunReview(targetInput, context);
    const inheritedAskResult = await poll(inheritedAskStart.requestId);
    assert.equal(inheritedAskResult.reviewerPermissionMode, "read-only");
    assert.equal(created.length, 11);
    assert.equal(created[10].config.modeId, "plan", "provider-level Read-only/Plan takes priority over parent Ask");
    parentProvider = "parent-provider";
    parentAvailableModes = [{ id: "read-only", label: "Read-only", description: "Read-only review mode" }];

    parentWorkspaceId = "another-workspace";
    await assert.rejects(() => service.startRunReview(targetInput, context), /not the selected workspace/);
    assert.equal(created.length, 11, "workspace mismatch is rejected before creating any reviewer");
    parentWorkspaceId = "workspace-1";
    currentSettings = {
      ...currentSettings,
      reviewerStrategy: "custom",
      reviewerProvider: "review-provider",
      reviewerModel: "review-model",
      reviewerThinkingOptionId: "deep",
      aiReviewCacheEnabled: true,
      defaultReviewPreset: "economical",
    };
    const presetRunsBefore = created.length;
    const economicalStart = await service.startRunReview(targetInput, context);
    const economicalResult = await poll(economicalStart.requestId);
    assert.equal(economicalResult.depth, "targeted");
    assert.equal(economicalResult.reviewPreset, "economical");
    assert.ok(created[presetRunsBefore].prompt.includes("Review budget: Economical"));
    assert.ok(created[presetRunsBefore].prompt.includes("medium/low/informational: skip"));
    assert.equal(created[presetRunsBefore].config.provider, "review-provider/review-model");

    const cachedEconomicalStart = await service.startRunReview(targetInput, context);
    assert.equal((await poll(cachedEconomicalStart.requestId)).resultSource, "cached");
    assert.equal(created.length, presetRunsBefore + 1, "the preset participates in cache identity");

    const economicalFullStart = await service.startRunReview(
      { ...targetInput, reviewDepthOverride: "full" },
      context,
    );
    const economicalFull = await poll(economicalFullStart.requestId);
    assert.equal(economicalFull.depth, "full");
    assert.equal(economicalFull.reviewPreset, "economical");
    assert.ok(created[presetRunsBefore + 1].prompt.includes("AI_REVIEW_PATCH_SENTINEL"));
    assert.ok(created[presetRunsBefore + 1].prompt.includes("medium/low/informational: skip"));

    currentSettings = { ...currentSettings, defaultReviewPreset: "deep" };
    const deepStart = await service.startRunReview(targetInput, context);
    const deep = await poll(deepStart.requestId);
    assert.equal(deep.depth, "full", "Deep defaults to a full-context review");
    assert.equal(deep.reviewPreset, "deep");
    assert.ok(created[presetRunsBefore + 2].prompt.includes("inspect every hunk"));

    const deepTargetedStart = await service.startRunReview(
      { ...targetInput, reviewDepthOverride: "targeted" },
      context,
    );
    const deepTargeted = await poll(deepTargetedStart.requestId);
    assert.equal(deepTargeted.depth, "targeted");
    assert.equal(deepTargeted.reviewPreset, "deep", "Targeted/Full overrides change patch context, not risk coverage");
    assert.ok(!created[presetRunsBefore + 3].prompt.includes("AI_REVIEW_PATCH_SENTINEL"));
    assert.ok(created[presetRunsBefore + 3].prompt.includes("inspect every hunk"));
    assert.equal(created.length, presetRunsBefore + 4);
    currentSettings = { ...currentSettings, aiReviewCacheEnabled: false };
    const recoverableStart = await service.startRunReview(fileInput, context);
    const persistedBeforeReload = await runStore.get(recoverableStart.requestId);
    assert.equal(persistedBeforeReload?.status, "running");
    assert.ok(persistedBeforeReload?.childAgentId);
    const recoverableChild = children.get(persistedBeforeReload.childAgentId);
    assert.ok(recoverableChild);
    assert.equal(created[created.length - 1]?.labels?.["review-deck.request"], recoverableStart.requestId);
    assert.equal(created[created.length - 1]?.labels?.["review-deck.kind"], "ai-review");

    const restartedService = createService();
    const wrongWorkspacePoll = await restartedService.pollAiReview({
      requestId: recoverableStart.requestId,
      workspaceId: "another-workspace",
      agentId: "parent-agent",
    }, context);
    assert.equal(wrongWorkspacePoll.status, "error", "a request cannot be recovered from another workspace");
    assert.equal((await runStore.get(recoverableStart.requestId))?.status, "running");
    const recoveredAfterReload = await pollWith(restartedService, recoverableStart.requestId);
    assert.equal(recoveredAfterReload.status, "idle");
    assert.equal(recoveredAfterReload.resultSource, "fresh");
    assert.equal(recoveredAfterReload.mode, "file");
    assert.equal((await runStore.get(recoverableStart.requestId))?.status, "completed");

    const archivedStart = await service.startRunReview(fileInput, context);
    const archivedRun = await runStore.get(archivedStart.requestId);
    assert.ok(archivedRun?.childAgentId);
    const archivedChild = children.get(archivedRun.childAgentId);
    assert.ok(archivedChild);
    archivedChild.agent.archivedAt = new Date().toISOString();
    const archivedPoll = await pollWith(createService(), archivedStart.requestId);
    assert.equal(archivedPoll.status, "error", "an archived reviewer child is never restored");
    assert.equal((await runStore.get(archivedStart.requestId))?.status, "abandoned");

    const expiredStart = await service.startRunReview(fileInput, context);
    await runStore.update(expiredStart.requestId, (current) => ({
      ...current,
      startedAt: new Date(Date.now() - 61 * 60_000).toISOString(),
    }));
    const expiredPoll = await pollWith(createService(), expiredStart.requestId);
    assert.equal(expiredPoll.status, "error", "runs past the TTL are abandoned rather than resumed");
    assert.equal((await runStore.get(expiredStart.requestId))?.status, "abandoned");
    const failingRunStore = {
      list: async () => { throw new Error("simulated run store read failure"); },
      get: (requestId: string) => runStore.get(requestId),
      create: (run: ReviewRun) => runStore.create(run),
      update: (requestId: string, transform: (run: ReviewRun) => ReviewRun | Promise<ReviewRun>) =>
        runStore.update(requestId, async (run) => {
          const updated = await transform(run);
          if (updated.status === "completed" || updated.status === "failed") {
            throw new Error("simulated terminal run store write failure");
          }
          return updated;
        }),
      remove: (requestId: string) => runStore.remove(requestId),
    } as unknown as ReviewRunStore;
    const serviceWithStoreFailure = new ReviewService({
      settings: settings as unknown as ReviewDeckSettingsHandle,
      aiReviewCacheStore: cacheStore,
      reviewRunStore: failingRunStore,
    });
    const previousConsoleError = console.error;
    console.error = () => {};
    try {
      const started = await serviceWithStoreFailure.startRunReview(fileInput, context);
      const result = await serviceWithStoreFailure.pollAiReview({
        requestId: started.requestId,
        workspaceId: "workspace-1",
        agentId: "parent-agent",
      }, context);
      assert.equal(result.status, "idle");
      assert.ok(result.review.includes("The reviewed snapshot contains the selected change."));
      assert.equal((await runStore.get(started.requestId))?.status, "running");
    } finally {
      console.error = previousConsoleError;
    }
    currentSettings = {
      ...currentSettings,
      reviewerStrategy: "inherit",
      aiReviewCacheEnabled: false,
    };
    parentProvider = "codex";
    parentAvailableModes = [{ id: "auto", label: "Default Permissions", description: "Edit files and run commands with Codex's default approval flow." }];
    responseQueue.push(JSON.stringify({
      summary: "Codex structured summary",
      findings: [{
        filePath: "a.ts",
        severity: "medium",
        evidenceKind: "ai_inference",
        category: "structured-output",
        summary: "The supported provider received the schema.",
        detail: "The structured response passed Zod validation.",
      }],
    }));
    const supportedOutputStart = await service.startRunReview(targetInput, context);
    const supportedCreate = created[created.length - 1];
    assert.equal(supportedCreate?.config.provider, "codex/parent-model");
    assert.equal(supportedCreate?.config.modeId, "auto");
    assert.deepEqual(supportedCreate?.config.options, {
      approval_policy: "on-request",
      sandbox_mode: "read-only",
    }, "Codex's default mode must be constrained by provider options for read-only review");
    assert.ok(supportedCreate?.outputSchema, "known schema-capable providers receive outputSchema");
    const supportedOutput = await poll(supportedOutputStart.requestId);
    assert.equal(supportedOutput.sections.summary, "Codex structured summary");
    assert.equal(supportedOutput.reviewerPermissionMode, "read-only");
    assert.equal(supportedOutput.resultSource, "fresh");
    responseQueue.push([
      "```json",
      "{\"findings\":[{\"severity\":\"urgent\"}]}",
      "```",
      "### Verified Facts",
      "- Markdown fallback survived invalid structured JSON.",
    ].join("\n"));
    const invalidStructuredStart = await service.startRunReview(targetInput, context);
    const invalidStructured = await poll(invalidStructuredStart.requestId);
    assert.equal(invalidStructured.status, "idle");
    assert.equal(
      invalidStructured.sections.verifiedFacts[0],
      "Markdown fallback survived invalid structured JSON.",
    );
    currentSettings = {
      ...currentSettings,
      aiReviewCacheEnabled: true,
      defaultReviewPreset: "balanced",
    };
    const cacheFillStart = await service.startRunReview(targetInput, context);
    assert.equal((await poll(cacheFillStart.requestId)).status, "idle");
    const missingCacheStart = await service.startRunReview(targetInput, context);
    assert.equal((await runStore.get(missingCacheStart.requestId))?.resultSource, "cached");
    await service.clearAiReviewCache();
    const missingCachePoll = await pollWith(createService(), missingCacheStart.requestId);
    assert.equal(missingCachePoll.status, "error");
    assert.equal((await runStore.get(missingCacheStart.requestId))?.status, "completed");

    currentSettings = { ...currentSettings, aiReviewCacheEnabled: false };
    const unreadableStoreStart = await service.startRunReview(fileInput, context);
    const unreadableRunStore = {
      list: () => runStore.list(),
      get: async (_requestId: string): Promise<ReviewRun | null> => {
        throw new Error("simulated damaged runs.json");
      },
      create: (run: ReviewRun) => runStore.create(run),
      update: (requestId: string, transform: (run: ReviewRun) => ReviewRun | Promise<ReviewRun>) =>
        runStore.update(requestId, transform),
      remove: (requestId: string) => runStore.remove(requestId),
    } as unknown as ReviewRunStore;
    const unreadableService = new ReviewService({
      settings: settings as unknown as ReviewDeckSettingsHandle,
      aiReviewCacheStore: cacheStore,
      reviewRunStore: unreadableRunStore,
    });
    const previousReadError = console.error;
    console.error = () => {};
    try {
      const unreadablePoll = await pollWith(unreadableService, unreadableStoreStart.requestId);
      assert.equal(unreadablePoll.status, "error");
      assert.equal(unreadablePoll.review, "The AI review request is no longer available.");
      assert.ok(!unreadablePoll.review.includes("damaged runs.json"));
    } finally {
      console.error = previousReadError;
    }
    // -----------------------------------------------------------------------
    // v1.7 workspace activity: Paseo-derived binding, count-only metadata,
    // refreshed anchor states in the detailed summary, and the read transition
    // -----------------------------------------------------------------------
    const activityStatePath = join(tmpdir(), `review-deck-activity-state-${randomUUID()}.json`);
    const activityBatchPath = join(tmpdir(), `review-deck-activity-batches-${randomUUID()}.json`);
    const activityRunPath = join(tmpdir(), `review-deck-activity-runs-${randomUUID()}.json`);
    activityPaths.push(activityStatePath, activityBatchPath, activityRunPath);
    const activityStateStore = new StateStore(activityStatePath);
    const activityBatchStore = new ReviewBatchStore(activityBatchPath);
    const activityRunStore = new ReviewRunStore(activityRunPath);
    const activityService = new ReviewService({
      settings: settings as unknown as ReviewDeckSettingsHandle,
      store: activityStateStore,
      aiReviewCacheStore: cacheStore,
      reviewBatchStore: activityBatchStore,
      reviewRunStore: activityRunStore,
    });

    // A third changed file keeps three distinct current hunks available.
    await writeFile(join(root, "c.ts"), "export const c = 1;\nexport const ACTIVITY_SENTINEL = 2;\n");
    const activitySnapshot = await activityService.createSnapshot({ cwd: root, scope: "working" });
    const activityHunks = activitySnapshot.files.flatMap((file) => file.hunks);
    assert.equal(activityHunks.length, activitySnapshot.totalHunks);
    assert.ok(activityHunks.length >= 3, "the activity fixtures need three current hunks");
    const [hunkA, hunkB, hunkC] = activityHunks;

    const seedComment = async (input: {
      hunkId: string;
      hunkFingerprint: string;
      filePath: string;
      hunkHeader: string;
      hunkPatch: string;
      targetFingerprint: string;
      comment?: string;
      workspaceId?: string;
      decision?: "reviewed" | "commented";
    }): Promise<void> => {
      await activityService.recordDecision({
        projectId: "project-1",
        cwd: root,
        targetFingerprint: input.targetFingerprint,
        hunkId: input.hunkId,
        hunkFingerprint: input.hunkFingerprint,
        filePath: input.filePath,
        hunkHeader: input.hunkHeader,
        hunkPatch: input.hunkPatch,
        decision: input.decision ?? "commented",
        scope: "working",
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
      });
    };
    const seedHunkComment = (hunk: typeof hunkA, input: {
      targetFingerprint: string;
      comment?: string;
      workspaceId?: string;
      decision?: "reviewed" | "commented";
    }): Promise<void> => seedComment({
      hunkId: hunk.id,
      hunkFingerprint: hunk.fingerprint,
      filePath: hunk.filePath,
      hunkHeader: hunk.header,
      hunkPatch: hunk.patch,
      ...input,
    });
    // A/B/E belong to the workspace's current working target; C is another
    // workspace's comment in a different target; D is a legacy row without a
    // workspaceId whose stored anchor no longer exists anywhere.
    await seedHunkComment(hunkA, { targetFingerprint: activitySnapshot.targetFingerprint, comment: "A WORKSPACE COMMENT", workspaceId: "workspace-1" });
    await seedHunkComment(hunkB, { targetFingerprint: activitySnapshot.targetFingerprint, comment: "B WORKSPACE COMMENT", workspaceId: "workspace-1" });
    await seedHunkComment(hunkC, { targetFingerprint: activitySnapshot.targetFingerprint, workspaceId: "workspace-1", decision: "reviewed" });
    await seedHunkComment(hunkC, { targetFingerprint: "c-foreign-target", comment: "C FOREIGN COMMENT", workspaceId: "workspace-2" });
    await seedComment({
      hunkId: "legacy-hunk",
      hunkFingerprint: "legacy-hunk-fingerprint",
      filePath: "legacy.ts",
      hunkHeader: "@@ -1 +1 @@",
      hunkPatch: "@@ -1 +1 @@\n-old legacy line\n+new legacy line\n",
      targetFingerprint: "d-legacy-target",
      comment: "D LEGACY COMMENT",
    });
    const seededState = await activityStateStore.load();
    for (const entries of Object.values(seededState)) {
      for (const entry of entries) {
        if (entry.comment === "A WORKSPACE COMMENT") entry.anchorState = "stale";
        if (entry.comment === "C FOREIGN COMMENT") entry.anchorState = "ambiguous";
        if (entry.comment === "D LEGACY COMMENT") entry.anchorState = "stale";
      }
    }
    await activityStateStore.save(seededState);

    await activityBatchStore.create({
      id: "activity-batch-active",
      createdAt: new Date().toISOString(),
      projectId: "project-1",
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      commentIds: ["activity-comment-active"],
      status: "draft",
      outcomes: {},
    });
    await activityBatchStore.create({
      id: "activity-batch-other",
      createdAt: new Date().toISOString(),
      projectId: "project-1",
      workspaceId: "workspace-2",
      agentId: "other-agent",
      commentIds: ["activity-comment-other"],
      status: "submitted",
      submittedAt: new Date().toISOString(),
      outcomes: {},
    });
    await activityBatchStore.create({
      id: "activity-batch-done",
      createdAt: new Date().toISOString(),
      projectId: "project-1",
      workspaceId: "workspace-1",
      agentId: "parent-agent",
      commentIds: ["activity-comment-done"],
      status: "completed",
      submittedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      outcomes: { "activity-comment-done": "completed" },
    });

    const seedRun = (input: {
      requestId: string;
      status: "running" | "completed" | "failed";
      workspaceId?: string;
      findingCount?: number;
      highRiskFindingCount?: number;
      readAt?: string;
    }): Promise<ReviewRun> => activityRunStore.create({
      requestId: input.requestId,
      childAgentId: input.status === "completed" ? "activity-review-child" : null,
      parentAgentId: "parent-agent",
      workspaceId: input.workspaceId ?? "workspace-1",
      cacheKey: `activity-cache-${input.requestId}`,
      mode: "file",
      status: input.status,
      resultSource: "fresh",
      startedAt: new Date().toISOString(),
      provider: "review-provider",
      model: "review-model",
      thinkingOptionId: null,
      reviewerPermissionMode: "read-only",
      cacheEnabled: false,
      inputFingerprint: `activity-fingerprint-${input.requestId}`,
      promptVersion: 4,
      schemaVersion: 2,
      ...(input.findingCount !== undefined ? { findingCount: input.findingCount } : {}),
      ...(input.highRiskFindingCount !== undefined ? { highRiskFindingCount: input.highRiskFindingCount } : {}),
      ...(input.readAt !== undefined ? { readAt: input.readAt } : {}),
    });
    await seedRun({ requestId: "activity-run-unread", status: "completed", findingCount: 3, highRiskFindingCount: 2 });
    await seedRun({ requestId: "activity-run-clean", status: "completed", findingCount: 0, highRiskFindingCount: 0 });
    await seedRun({ requestId: "activity-run-read", status: "completed", findingCount: 5, highRiskFindingCount: 1, readAt: new Date().toISOString() });
    await seedRun({ requestId: "activity-run-other", status: "completed", workspaceId: "workspace-2", findingCount: 9, highRiskFindingCount: 4 });
    await seedRun({ requestId: "activity-run-failed", status: "failed", findingCount: 0, highRiskFindingCount: 0 });
    await seedRun({ requestId: "activity-run-running", status: "running" });

    const expectedIndicators = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      // Pending and stale are disjoint action categories: pending + stale is
      // the raw queued total (4 project-wide, 3 in this workspace).
      projectPendingCommentCount: 1,
      projectStaleCommentCount: 3,
      workspacePendingCommentCount: 1,
      workspaceStaleCommentCount: 2,
      activeBatchCount: 1,
      runningAiReviewCount: 1,
      unreadAiFindingCount: 3,
    };
    const indicators = await activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-1" }, context);
    assert.deepStrictEqual(indicators, expectedIndicators);
    assert.ok(
      !JSON.stringify(indicators).includes("COMMENT"),
      "no comment body may leave the server through an indicator read",
    );

    // A workspace that cannot be resolved, has moved, or is being archived
    // fails closed instead of reporting another workspace's activity.
    workspaceRecord = { id: "workspace-1", projectId: "project-1", workspaceDirectory: root, archivingAt: "2026-10-01T00:00:00.000Z" };
    await assert.rejects(
      () => activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-1" }, context),
      /being archived/,
    );
    workspaceRecord = { id: "workspace-other", projectId: "project-1", workspaceDirectory: root };
    await assert.rejects(
      () => activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-1" }, context),
      /resolved to workspace workspace-other/,
    );
    workspaceRecord = null;
    await assert.rejects(
      () => activityService.getWorkspaceReviewSummary({ workspaceId: "workspace-1" }, context),
      /does not exist/,
    );
    await assert.rejects(
      () => activityService.markWorkspaceReviewResultsRead({ workspaceId: "workspace-1" }, context),
      /does not exist/,
    );
    workspaceRecord = { id: "workspace-1", projectId: "project-1", workspaceDirectory: root };

    // The detailed summary refreshes the anchors of the working tree first: the
    // stale-but-resolvable comment becomes exact while the legacy comment
    // without a current hunk stays stale, and the legacy row keeps its
    // workspace binding because this workspace is the directory's sole owner.
    const summary = await activityService.getWorkspaceReviewSummary({ workspaceId: "workspace-1" }, context);
    assert.deepStrictEqual(summary, {
      ...expectedIndicators,
      projectPendingCommentCount: 2,
      projectStaleCommentCount: 2,
      workspacePendingCommentCount: 2,
      workspaceStaleCommentCount: 1,
      reviewedBlockCount: 3,
      totalBlockCount: activitySnapshot.totalHunks,
    });
    const refreshedState = await activityStateStore.load();
    const refreshedAnchorStates = Object.values(refreshedState)
      .flat()
      .filter((entry) => entry.comment === "A WORKSPACE COMMENT")
      .map((entry) => entry.anchorState);
    assert.deepStrictEqual(refreshedAnchorStates, ["exact"], "the summary refreshed the resolvable anchor");

    // A legacy comment is only assigned while this workspace is the project's
    // sole owner of its directory: a shared directory, a failed list, or a
    // truncated page keeps it project-scoped.
    workspaceListEntries = [
      { id: "workspace-1", workspaceDirectory: root },
      { id: "workspace-2", workspaceDirectory: root },
    ];
    const sharedDirectory = await activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-1" }, context);
    assert.equal(sharedDirectory.projectPendingCommentCount, 2);
    assert.equal(sharedDirectory.projectStaleCommentCount, 2, "project pending + stale stays the raw queued total of 4");
    assert.equal(sharedDirectory.workspacePendingCommentCount, 2, "a shared directory forfeits the legacy assignment");
    assert.equal(sharedDirectory.workspaceStaleCommentCount, 0);
    failWorkspaceList = true;
    const listFailure = await activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-1" }, context);
    assert.equal(listFailure.workspacePendingCommentCount, 2, "a failed ownership list keeps legacy comments project-scoped");
    assert.equal(listFailure.workspaceStaleCommentCount, 0);
    failWorkspaceList = false;
    workspaceListPageHasMore = true;
    const truncatedList = await activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-1" }, context);
    assert.equal(truncatedList.workspacePendingCommentCount, 2, "a truncated ownership list cannot prove uniqueness");
    assert.equal(truncatedList.workspaceStaleCommentCount, 0);
    workspaceListPageHasMore = false;
    workspaceListEntries = [{ id: "workspace-1", workspaceDirectory: root }];
    const soleOwner = await activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-1" }, context);
    assert.equal(soleOwner.workspacePendingCommentCount, 2, "the sole owner counts the legacy comment's pending and stale buckets");
    assert.equal(soleOwner.workspaceStaleCommentCount, 1, "the stale legacy comment stays in the stale bucket, not in pending");

    // Opening the deck marks every completed file/target run that reported
    // findings, in this workspace only.
    assert.deepStrictEqual(
      await activityService.markWorkspaceReviewResultsRead({ workspaceId: "workspace-1" }, context),
      { markedRunCount: 1 },
    );
    assert.deepStrictEqual(
      await activityService.markWorkspaceReviewResultsRead({ workspaceId: "workspace-1" }, context),
      { markedRunCount: 0 },
      "a second opening marks nothing new",
    );
    assert.ok((await activityRunStore.get("activity-run-unread"))?.readAt, "the unread run is stamped");
    assert.strictEqual(
      (await activityRunStore.get("activity-run-clean"))?.readAt,
      undefined,
      "a completed run with nothing to read is left unmarked",
    );
    assert.ok((await activityRunStore.get("activity-run-read"))?.readAt);
    assert.strictEqual((await activityRunStore.get("activity-run-running"))?.readAt, undefined);
    assert.strictEqual((await activityRunStore.get("activity-run-failed"))?.readAt, undefined);
    assert.strictEqual(
      (await activityRunStore.get("activity-run-other"))?.readAt,
      undefined,
      "another workspace's run is never marked by this workspace's opening",
    );
    const afterRead = await activityService.getWorkspaceReviewIndicators({ workspaceId: "workspace-1" }, context);
    assert.equal(afterRead.unreadAiFindingCount, 0);

    // -----------------------------------------------------------------------
    // v1.7 AI review timeline row: one stable, minimal row on the parent Agent
    // -----------------------------------------------------------------------
    currentSettings = { ...currentSettings, aiReviewCacheEnabled: false };
    responseQueue.push(JSON.stringify({
      summary: "Activity review summary",
      findings: [
        {
          filePath: "a.ts",
          severity: "high",
          evidenceKind: "ai_inference",
          category: "activity",
          summary: "High-risk activity finding",
          detail: "High-risk activity detail",
        },
        {
          filePath: "b.ts",
          severity: "low",
          evidenceKind: "verified_fact",
          category: "activity",
          summary: "Low-risk activity finding",
          detail: "Low-risk activity detail",
        },
      ],
    }));
    const timelineStart = await service.startRunReview(reviewInput(root, "file", "a.ts"), context);
    const timelineBefore = timelineAppends.length;
    const timelineResult = await poll(timelineStart.requestId);
    assert.equal(timelineResult.status, "idle");
    assert.equal(timelineResult.resultSource, "fresh");
    const appendedRows = timelineAppends
      .slice(timelineBefore)
      .filter((entry) => entry.item.kind === "review-deck-ai-review");
    assert.equal(appendedRows.length, 1, "a terminal file review appends exactly one AI review row");
    const appendedRow = appendedRows[0];
    assert.equal(appendedRow.agentId, "parent-agent", "the row lands on the parent Agent whose stream shows the result");
    assert.equal(appendedRow.item.id, `review-deck-ai-review:${timelineStart.requestId}`);
    assert.equal(appendedRow.item.version, 1);
    assert.deepStrictEqual(
      Object.keys(appendedRow.item.data).sort(),
      ["completedAt", "depth", "findingCount", "highRiskFindingCount", "mode", "resultSource", "status", "usage", "workspaceId"],
    );
    assert.equal(appendedRow.item.data.workspaceId, "workspace-1");
    assert.equal(appendedRow.item.data.mode, "file");
    assert.equal(appendedRow.item.data.status, "completed");
    assert.equal(appendedRow.item.data.resultSource, "fresh");
    assert.equal(appendedRow.item.data.depth, "targeted");
    assert.equal(appendedRow.item.data.findingCount, 2);
    assert.equal(appendedRow.item.data.highRiskFindingCount, 1);
    assert.ok(typeof appendedRow.item.data.completedAt === "string" && appendedRow.item.data.completedAt.length > 0);
    const timelinePayload = JSON.stringify(appendedRow.item.data);
    for (const secret of ["a.ts", "b.ts", "High-risk activity", "Low-risk activity", "Activity review summary", timelineStart.requestId]) {
      assert.ok(!timelinePayload.includes(secret), `the timeline row must not leak ${secret}`);
    }
    // The terminal poll stamped the run itself: completion time and tally are
    // durable metadata, and nothing is marked read yet.
    const stampedRun = await runStore.get(timelineStart.requestId);
    assert.equal(stampedRun?.status, "completed");
    assert.equal(stampedRun?.completedAt, appendedRow.item.data.completedAt);
    assert.equal(stampedRun?.findingCount, 2);
    assert.equal(stampedRun?.highRiskFindingCount, 1);
    assert.strictEqual(stampedRun?.readAt, undefined);
    // A repeated poll (now a cache-capability read of the same result) replaces
    // the same row with byte-identical data instead of appending a second one.
    const appendsBeforeRepeat = timelineAppends.length;
    await poll(timelineStart.requestId);
    const repeatedRows = timelineAppends
      .slice(appendsBeforeRepeat)
      .filter((entry) => entry.item.kind === "review-deck-ai-review");
    assert.equal(repeatedRows.length, 1);
    assert.deepStrictEqual(repeatedRows[0].item, appendedRow.item);
    // An append failure is swallowed: the review result itself still returns.
    failNextTimelineAppend = true;
    const previousAppendError = console.error;
    console.error = () => {};
    try {
      const resilientPoll = await poll(timelineStart.requestId);
      assert.equal(resilientPoll.status, "idle");
      assert.ok(resilientPoll.review.length > 0, "the result survives a failed timeline append");
    } finally {
      console.error = previousAppendError;
    }
    // A hunk explanation is not a whole AI review and never appends the row.
    const hunkView = await service.createSnapshot({ cwd: root, scope: "working", filePath: "a.ts", locale: "en" });
    const explainHunkId = hunkView.files.find((file) => file.path === "a.ts")?.hunks[0]?.id;
    assert.ok(explainHunkId);
    const hunkExplainStart = await service.startExplainHunkAi({
      cwd: root,
      scope: "working",
      locale: "en",
      filePath: "a.ts",
      hunkId: explainHunkId,
      workspaceId: "workspace-1",
      agentId: "parent-agent",
    }, context);
    const appendsBeforeHunk = timelineAppends.length;
    const hunkExplain = await poll(hunkExplainStart.requestId);
    assert.equal(hunkExplain.status, "idle");
    assert.equal(hunkExplain.mode, "hunk");
    assert.equal(timelineAppends.length, appendsBeforeHunk, "hunk explanations never append an AI review row");
    const hunkRun = await runStore.get(hunkExplainStart.requestId);
    assert.equal(hunkRun?.status, "completed");
    assert.ok(hunkRun?.completedAt, "a hunk explanation still records its completion time");
    assert.strictEqual(hunkRun?.findingCount, undefined, "a hunk explanation never records a finding tally");
    assert.strictEqual(hunkRun?.highRiskFindingCount, undefined, "a hunk explanation never records a high-risk tally");
    // A failed review still reports its terminal state, with zero findings.
    responseQueue.push("### Verified Facts\n- Failed review body.");
    waitStatusQueue.push("error");
    const failedStart = await service.startRunReview(reviewInput(root, "target"), context);
    const appendsBeforeFailure = timelineAppends.length;
    const failedPoll = await poll(failedStart.requestId);
    assert.equal(failedPoll.status, "error");
    assert.ok(failedPoll.review.includes("Failed review body."));
    const failedRows = timelineAppends
      .slice(appendsBeforeFailure)
      .filter((entry) => entry.item.kind === "review-deck-ai-review");
    assert.equal(failedRows.length, 1);
    assert.equal(failedRows[0].item.data.status, "failed");
    assert.equal(failedRows[0].item.data.mode, "target");
    assert.equal(failedRows[0].item.data.findingCount, 0);
    assert.equal(failedRows[0].item.data.highRiskFindingCount, 0);
    const failedRun = await runStore.get(failedStart.requestId);
    assert.equal(failedRun?.status, "failed");
    assert.strictEqual(failedRun?.findingCount, undefined, "a failed review records no finding tally");
    assert.strictEqual(failedRun?.highRiskFindingCount, undefined);
    // A cache hit is stamped on its first poll with the tally of the cached
    // sections (a Markdown fallback has no machine-readable severity).
    const cachedStamp = await runStore.get(cachedTargetStart.requestId);
    assert.equal(cachedStamp?.status, "completed");
    assert.ok(cachedStamp?.completedAt, "a cache hit gets its completion time on the first poll");
    assert.equal(cachedStamp?.findingCount, 3);
    assert.equal(cachedStamp?.highRiskFindingCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (cachePath) await rm(cachePath, { force: true });
    if (runStorePath) await rm(runStorePath, { force: true });
    for (const path of activityPaths) await rm(path, { force: true });
  }
}

void run().then(() => {
  console.log("AI review service integration: all assertions passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
