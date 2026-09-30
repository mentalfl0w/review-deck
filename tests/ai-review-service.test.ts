import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { ReviewService } from "../server/ReviewService";
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
    const created: Array<{ config: Record<string, unknown>; prompt: string; cwd: string; parent: string }> = [];
    const parentAgent = () => ({
      id: "parent-agent",
      workspaceId: parentWorkspaceId,
      cwd: root,
      provider: parentProvider,
      model: "parent-model",
      thinkingOptionId: "parent-thinking",
      availableModes: parentAvailableModes,
    });
    const context = {
      paseo: {
        agents: {
          ref: () => ({ current: parentAgent, refresh: async () => ({ agent: parentAgent() }) }),
          create: async (options: { config: Record<string, unknown>; prompt: string; cwd: string; parent: string }) => {
            created.push(options);
            return {
              id: `review-child-${created.length}`,
              waitForFinish: async () => ({
                status: "idle",
                error: null,
                lastMessage: RESPONSE,
                final: { lastUsage: USAGE },
              }),
            };
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
    const service = new ReviewService({
      settings: settings as unknown as ReviewDeckSettingsHandle,
      aiReviewCacheStore: cacheStore,
    });
    const poll = (requestId: string) => service.pollAiReview({
      requestId,
      workspaceId: "workspace-1",
      agentId: "parent-agent",
    });

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
    const cachedTarget = await poll(cachedTargetStart.requestId);
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
    const afterClearStart = await service.startRunReview(fileInput, context);
    const afterClear = await poll(afterClearStart.requestId);
    assert.equal(afterClear.resultSource, "fresh", "clearing the cache forces a new reviewer run");
    assert.equal(created.length, 6);
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
  } finally {
    await rm(root, { recursive: true, force: true });
    if (cachePath) await rm(cachePath, { force: true });
  }
}

void run().then(() => {
  console.log("AI review service integration: all assertions passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
