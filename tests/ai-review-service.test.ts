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
              return { id: agentId, current: parentAgent, refresh: async () => ({ agent: parentAgent() }) };
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
                status: "idle" as const,
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
          ref: () => ({ current: () => ({ workspaceDirectory: root }), refresh: async () => ({ workspaceDirectory: root }) }),
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
    parentAvailableModes = [{ id: "read-only", label: "Read-only", description: "Read-only review mode" }];
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
    assert.ok(supportedCreate?.outputSchema, "known schema-capable providers receive outputSchema");
    const supportedOutput = await poll(supportedOutputStart.requestId);
    assert.equal(supportedOutput.sections.summary, "Codex structured summary");
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
  } finally {
    await rm(root, { recursive: true, force: true });
    if (cachePath) await rm(cachePath, { force: true });
    if (runStorePath) await rm(runStorePath, { force: true });
  }
}

void run().then(() => {
  console.log("AI review service integration: all assertions passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
