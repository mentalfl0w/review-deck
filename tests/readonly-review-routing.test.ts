/**
 * Source-level routing assertions for read-only AI reviews.
 *
 * Read-only reviews (AI评审变更块 via startExplainHunkAi, AI评审文件 via
 * startRunReview) must run on a TRANSIENT child agent (context.paseo.agents.create
 * + child.waitForFinish + autoArchive) so nothing pollutes the selected workspace
 * Agent's message stream. Because the plugin host RPC layer times out long
 * reviews, the flow is split: a start RPC validates the workspace-bound agent
 * gate, creates the child, and returns a per-request capability (randomUUID —
 * NEVER the child's globally discoverable agent id) as the requestId (NO
 * waiting in the handler); a poll RPC repeats the start-time workspace/agent
 * binding and waits in short windows, resolving the result. The daemon's
 * create_agent_request schema requires config.provider in combined
 * "provider/model" format with NO separate model key, derived from the
 * selected workspace Agent's snapshot. Editing flows hand the prompt to the
 * selected Agent's workflow fire-and-forget (processProjectReview handle.send,
 * client reviseCurrentFromComment/reviseFileFromComment send) — never waited on
 * — remove the handed-over comments from Review Deck, and append one
 * content-minimal version-1 "review-deck-handoff" timeline row (send first,
 * best-effort append, queue clear last; the row records only the submission,
 * never completion, and carries no review content or identifiers).
 *
 * The fake-daemon harness (tests/agent-message-stream.test.ts) does not answer
 * create_agent_request, so this file asserts the routing contract at source level
 * and additionally validates the parent-derived combined config against the
 * daemon's own create_agent_request wire schema (CreateAgentRequestMessageSchema).
 *
 * Run: node tests/readonly-review-routing.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CreateAgentRequestMessageSchema } from "@getpaseo/protocol/messages";

// Tests run from the repository root (same model as agent-message-stream.test.ts).
const repoRoot = process.cwd();
const serviceSource = readFileSync(join(repoRoot, "server/ReviewService.ts"), "utf8");
const clientHookSource = readFileSync(join(repoRoot, "client/hooks/useAgentReview.ts"), "utf8");
const i18nSource = readFileSync(join(repoRoot, "client/i18n.ts"), "utf8");
const sharedSource = readFileSync(join(repoRoot, "shared/review.ts"), "utf8");

// 0. The superseded blocking RPCs are gone from the shared contract; the async
//    start/poll RPCs and the schemas/types the new flow still builds are kept.
assert.ok(!/\bexport const explainHunkAi\b/.test(sharedSource), "old explainHunkAi RPC export must be removed");
assert.ok(!/\bexport const runReview\b/.test(sharedSource), "old runReview RPC export must be removed");
assert.ok(!sharedSource.includes("review-deck.run-review"), "old run-review RPC name string must be removed");
assert.ok(!sharedSource.includes("review-deck.explain-hunk-ai"), "old explain-hunk-ai RPC name string must be removed");
assert.match(sharedSource, /export const startExplainHunkAi = defineRpc\(/, "startExplainHunkAi RPC must exist");
assert.match(sharedSource, /export const startRunReview = defineRpc\(/, "startRunReview RPC must exist");
assert.match(sharedSource, /export const pollAiReview = defineRpc\(/, "pollAiReview RPC must exist");
// The async read-only RPCs carry an explicit workspace binding; the poll
// repeats the start-time workspace/agent binding next to the capability.
assert.match(
  sharedSource,
  /input: reviewRequestSchema\.extend\(\{\n\s+hunkId: z\.string\(\)\.min\(1\),\n\s+agentId: z\.string\(\)\.min\(1\),\n\s+workspaceId: z\.string\(\)\.min\(1\),\n\s+\}\)/,
  "startExplainHunkAi input must bind workspaceId",
);
assert.match(
  sharedSource,
  /input: reviewRequestSchema\.extend\(\{ agentId: z\.string\(\)\.min\(1\), workspaceId: z\.string\(\)\.min\(1\) \}\)/,
  "startRunReview input must bind workspaceId",
);
assert.match(
  sharedSource,
  /input: z\.object\(\{\n\s+requestId: z\.string\(\)\.min\(1\),\n\s+workspaceId: z\.string\(\)\.min\(1\),\n\s+agentId: z\.string\(\)\.min\(1\),\n\s+\}\)/,
  "pollAiReview input must carry the request capability plus the workspace/agent binding",
);
assert.ok(!sharedSource.includes("commentOutcomes"), "process result schema must drop commentOutcomes");
assert.ok(!sharedSource.includes("completedCommentIds"), "process result schema must drop completedCommentIds");
assert.ok(!sharedSource.includes("projectReviewCommentOutcome"), "outcome schema/type must be removed from the shared contract");
assert.ok(!sharedSource.includes("clearProjectReviewComments"), "clear-project-review-comments RPC must be removed (submit now cleans up inline)");
assert.match(sharedSource, /submittedAt: z\.string\(\),/, "process result schema must carry submittedAt");
assert.match(
  sharedSource,
  /export const explainHunkAiResultSchema = explainHunkResultSchema\.extend\(\{/,
  "ExplainHunkAiResult schema must be kept (the client still builds that result type)",
);
assert.match(sharedSource, /export type ExplainHunkAiResult = z\.infer<typeof explainHunkAiResultSchema>;/, "ExplainHunkAiResult type must be kept");
assert.match(sharedSource, /export const aiReviewStatusSchema = /, "aiReviewStatusSchema must be kept");
assert.match(sharedSource, /export const pollAiReviewResultSchema = /, "pollAiReviewResultSchema must be kept");
assert.ok(!serviceSource.includes("AgentReviewResult"), "dead AgentReviewResult interface must be removed from the service");

// 1. No hardcoded model/provider config may remain in the service: the child
//    config must come from the selected workspace Agent's own snapshot.
assert.ok(!serviceSource.includes("deepseek/deepseek-v4-flash"), "no hardcoded model string may remain in the service");
assert.ok(!serviceSource.includes("READONLY_REVIEW_AGENT_CONFIG"), "hardcoded agent config constant must be removed");
assert.ok(!serviceSource.includes("READONLY_REVIEW_PROVIDER"), "hardcoded provider label constant must be removed");
assert.ok(!serviceSource.includes("READONLY_REVIEW_MODEL"), "hardcoded model label constant must be removed");
assert.ok(!serviceSource.includes("READONLY_REVIEW_WAIT_MS"), "blocking 120s wait constant must be removed");

// 2. Split flow: a create-only start (returns child id, registers it, does NOT
//    wait) plus a poll method. No waitForFinish(120_000) may run inside an RPC
//    handler anymore.
assert.match(serviceSource, /private async startTransientReviewAgent\(/, "create-only transient start must exist");
assert.match(
  serviceSource,
  /context\.paseo\.agents\.create\(\{\n\s+config: agentConfig,\n\s+cwd: input\.worktreePath,\n\s+parent: input\.agentId,\n\s+title: input\.locale === "zh" \? "Review Deck 只读评审" : "Review Deck read-only review",\n\s+autoArchive: true,\n\s+prompt: input\.prompt,\n\s+\}\)/,
  "start must create a transient child (combined provider config, cwd worktree, parent, autoArchive, prompt)",
);
assert.match(
  serviceSource,
  /const requestId = randomUUID\(\);\n\s+this\.transientReviewAgents\.set\(requestId, \{\n\s+handle: child,/,
  "start must register the child handle under a fresh per-request capability (randomUUID), never the child id",
);
assert.match(
  serviceSource,
  /workspaceId: input\.workspaceId,\n\s+agentId: input\.agentId,\n\s+startedAt: Date\.now\(\)/,
  "the registered entry must carry the workspace/agent binding recorded at start time",
);
assert.match(serviceSource, /return requestId;/, "start must return the capability as the requestId");
assert.ok(!serviceSource.includes("return child.id;"), "the child id (globally discoverable) must never be returned as the requestId");
const waitForFinishCalls = serviceSource.match(/\.waitForFinish\(/g) ?? [];
assert.equal(
  waitForFinishCalls.length,
  1,
  "waitForFinish must be called exactly once in the whole service — inside pollAiReview, never in the start handler",
);
assert.match(
  serviceSource,
  /async pollAiReview\(input: \{ requestId: string; workspaceId: string; agentId: string \}\)/,
  "poll method must take the request capability plus the workspace/agent binding",
);
assert.match(
  serviceSource,
  /if \(!entry \|\| entry\.workspaceId !== input\.workspaceId \|\| entry\.agentId !== input\.agentId\) \{/,
  "poll must refuse an unknown capability or a mismatched workspace/agent binding",
);
assert.match(
  serviceSource,
  /result = await entry\.handle\.waitForFinish\(READONLY_REVIEW_POLL_WAIT_MS\);/,
  "poll must wait in short windows (READONLY_REVIEW_POLL_WAIT_MS)",
);
assert.match(serviceSource, /if \(result\.status === "timeout"\) \{/, "poll must treat timeout as still-running");
assert.match(serviceSource, /status: "running", review: "", sections: emptyReviewSections\(\)/, "poll must return running while the child works");
assert.match(serviceSource, /this\.transientReviewAgents\.delete\(input\.requestId\);/, "poll must delete the entry once settled");
assert.match(
  serviceSource,
  /status: "error",\n\s+review: "The AI review request is no longer available\."/,
  "poll of an unknown requestId must return a clear error",
);
assert.match(serviceSource, /private sweepTransientReviewAgents\(\)/, "abandoned entries must be TTL-swept");
// 2b. Timeline fallback: when the turn settles without a final lastMessage
//     (turn ended after a tool call), the last assistant text is recovered
//     from the child's timeline; only then fall back to error/locale text.
assert.match(serviceSource, /private async extractLastAssistantText\(/, "timeline text recovery helper must exist");
assert.match(serviceSource, /handle\.timeline\.refetch\(\{ limit: 50 \}\)/, "helper must refetch the timeline tail (limit 50)");
assert.match(serviceSource, /for \(let index = entries\.length - 1; index >= 0; index -= 1\)/, "helper must walk the timeline in reverse");
assert.match(serviceSource, /item\.type !== "assistant_message"/, "helper must select assistant text entries only");
assert.match(
  serviceSource,
  /result\.lastMessage\?\.trim\(\)\n\s+\? result\.lastMessage\n\s+: \(\(await this\.extractLastAssistantText\(entry\.handle\)\) \?\? result\.error \?\? \(locale === "zh" \? "评审 Agent 未返回文本。" : "The review agent returned no text\."\)\)/,
  "settled with null/empty lastMessage must use timeline text, then error, then the locale fallback",
);

// 3. Start RPC methods exist and return { requestId }; both inputs carry the
//    workspace binding and the signatures type it.
assert.match(serviceSource, /async startExplainHunkAi\(/, "startExplainHunkAi must exist");
assert.match(serviceSource, /async startRunReview\(/, "startRunReview must exist");
assert.match(
  serviceSource,
  /input: ReviewRequest & \{ hunkId: string; agentId: string; workspaceId: string \}/,
  "startExplainHunkAi must type the workspace binding",
);
assert.match(
  serviceSource,
  /input: ReviewRequest & \{ agentId: string; workspaceId: string \}/,
  "startRunReview must type the workspace binding",
);
assert.match(serviceSource, /Promise<\{ requestId: string \}>/, "start methods must return the requestId");
assert.match(serviceSource, /this\.startTransientReviewAgent\(/, "start methods must use the create-only start");
assert.ok(!serviceSource.includes("async runAgentReview("), "old blocking runAgentReview must be removed");
assert.ok(!serviceSource.includes("async explainHunkWithAgent("), "old blocking explainHunkWithAgent must be removed");

// 3b. The workspace-bound agent gate lives in resolveParentAgentConfig and
//     runs BEFORE any child is created: the refreshed parent must belong to
//     the claimed workspace, the claimed workspace itself must resolve to the
//     reviewed worktree, and the parent agent must run in that worktree. A
//     foreign workspace Agent can never be bound to another workspace's diff.
assert.match(
  serviceSource,
  /if \(agent\.workspaceId !== input\.workspaceId\) \{/,
  "the refreshed parent agent must belong to the claimed workspace",
);
assert.match(
  serviceSource,
  /const workspaceHandle = context\.paseo\.workspaces\.ref\(input\.workspaceId\);/,
  "the claimed workspace must be refreshed (its id alone never authorizes a cwd)",
);
assert.match(
  serviceSource,
  /if \(!\(await this\.directoriesMatch\(workspaceDirectory, input\.worktreePath\)\)\) \{/,
  "the claimed workspace directory must BE the reviewed worktree",
);
assert.match(
  serviceSource,
  /if \(!agent\.cwd \|\| !\(await this\.directoriesMatch\(agent\.cwd, input\.worktreePath\)\)\) \{/,
  "the parent agent must run in the reviewed worktree",
);

// 4. The parent-snapshot resolver exists and refreshes the SELECTED agent
//    (fresh.agent ?? current(), falling back to current()).
assert.match(serviceSource, /private async resolveParentAgentConfig\(/, "parent snapshot resolver must exist");
assert.match(
  serviceSource,
  /const handle = context\.paseo\.agents\.ref\(input\.agentId\);[\s\S]*?const fresh = await handle\.refresh\(\);[\s\S]*?agent = fresh\?\.agent \?\? handle\.current\(\);[\s\S]*?agent = handle\.current\(\);/,
  "resolver must refresh the parent handle and fall back to current()",
);
assert.match(
  serviceSource,
  /provider: agent\.model \? `\$\{agent\.provider\}\/\$\{agent\.model\}\` : agent\.provider,/,
  "resolver must return the COMBINED provider/model string (provider alone when the parent has no model)",
);
assert.match(serviceSource, /agentProvider: agent\.provider,/, "display provider label must come from the parent snapshot");
assert.match(serviceSource, /agentModel: agent\.model \?\? null,/, "display model label must come from the parent snapshot");
assert.match(
  serviceSource,
  /thinkingOptionId: agent\.thinkingOptionId \?\? agent\.effectiveThinkingOptionId \?\? null,/,
  "thinking option must come from parent thinkingOptionId ?? effectiveThinkingOptionId",
);
assert.match(
  serviceSource,
  /无法解析所选工作区 Agent（\$\{input\.agentId\}）的配置，不能创建只读评审子 Agent。/,
  "unresolvable parent must throw a clear locale-aware zh error",
);
assert.match(
  serviceSource,
  /Could not resolve the selected workspace Agent \(\$\{input\.agentId\}\) configuration, so the read-only review child agent could not be created\./,
  "unresolvable parent must throw a clear locale-aware en error",
);

// 5. The child create config carries the combined provider and NO separate
//    model key (model is inside the combined provider string); thinkingOptionId
//    stays optional.
assert.match(
  serviceSource,
  /const agentConfig = \{\n\s+provider: resolved\.provider,\n\s+\.\.\.\(resolved\.thinkingOptionId \? \{ thinkingOptionId: resolved\.thinkingOptionId \} : \{\}\),\n\s+\};/,
  "child config must carry the combined provider only — no separate model key",
);
assert.ok(
  !/config: agentConfig[\s\S]{0,200}model:/.test(serviceSource),
  "no model key may be sent alongside the combined provider in the create config",
);

// No fallback: create/resolve failures must throw a clear error, never run on
// the selected workspace Agent's stream.
assert.match(serviceSource, /评审未运行在所选工作区 Agent 的会话流上。/u, "zh failure text must state the review never ran on the selected stream");
assert.match(serviceSource, /did not run on the selected workspace Agent's stream\./, "en failure text must state the review never ran on the selected stream");

// 6. No read-only flow may call agents.ref(input.agentId).run(...); locale
//    prompts, section parsing and status mapping are preserved.
const runOnRefPattern = /\.ref\(input\.agentId\)\.run\(/;
assert.ok(!runOnRefPattern.test(serviceSource), "no read-only flow may run on the selected agent's stream via agents.ref().run()");
assert.match(serviceSource, /agentInstructions\(locale, "review"\)/, "AI评审文件 prompt must keep the locale review instructions");
assert.match(serviceSource, /agentInstructions\(locale, "explain"\)/, "AI评审变更块 prompt must keep the locale explain instructions");
assert.match(serviceSource, /parseReviewSections\(review\)/, "poll must keep parseReviewSections");
assert.match(serviceSource, /model: entry\.model \?\? "unknown",/, "poll must report the parent display model (unknown only when the parent has none)");
assert.match(serviceSource, /provider: entry\.provider,/, "poll must report the parent display provider");

// 7. Editing flows hand the prompt to the selected workspace Agent's visible
//    stream fire-and-forget (handle.send — never run(), never waited on), then
//    remove the handed-over comments from Review Deck.
assert.ok(!serviceSource.includes("handle.run("), "processProjectReview must never run()/wait on the agent");
assert.match(serviceSource, /await handle\.send\(prompt\);/, "processProjectReview must hand the prompt to the agent's workflow via send");
assert.match(
  serviceSource,
  /await this\.clearProjectReviewComments\(input\.projectId\);[\s\S]{0,300}submittedAt: new Date\(\)\.toISOString\(\)/,
  "processProjectReview must clear the submitted comments after a successful send and return a submission confirmation",
);
assert.match(
  clientHookSource,
  /await paseo\.agents\.ref\(agentId\)\.send\(prompt\);/,
  "client reviseCurrentFromComment/reviseFileFromComment must keep agents.ref().send() on the selected agent's stream",
);
assert.match(
  clientHookSource,
  /await clearHunkComment\(selected\.id\);[\s\S]{0,120}void refreshProjectComments\(\);/,
  "reviseCurrentFromComment must clear the handed-over hunk comment and refresh the project list",
);
assert.match(
  clientHookSource,
  /const sentHunkId = activeSavedComment\?\.hunk\.id;[\s\S]{0,120}if \(sentHunkId\) await clearHunkComment\(sentHunkId\);[\s\S]{0,80}void refreshProjectComments\(\);/,
  "reviseFileFromComment must clear the handed-over file comment and refresh the project list",
);

// 7b. v0.8 submission timeline row: after the daemon ACCEPTS the send, the
//     service appends one content-minimal "review-deck-handoff" row to the
//     SAME agent's timeline, then clears the queue. Ordering is asserted by
//     source position (never by whitespace or generated ids), and the append
//     must be best-effort: a failure is swallowed so the queue clear still
//     runs and no error surfaces that could make a client retry re-send the
//     prompt and duplicate the Agent task.
const sendIndex = serviceSource.indexOf("await handle.send(prompt);");
const appendIndex = serviceSource.indexOf("await handle.timeline.append({");
const clearIndex = serviceSource.indexOf("await this.clearProjectReviewComments(input.projectId);");
assert.ok(
  sendIndex >= 0 && appendIndex > sendIndex && clearIndex > appendIndex,
  "ordering must be: accepted send, then the timeline append, then the queue clear",
);
const tryIndex = serviceSource.indexOf("try {", sendIndex);
const catchIndex = serviceSource.indexOf("catch (error)", sendIndex);
assert.ok(
  tryIndex > sendIndex && tryIndex < appendIndex && appendIndex < catchIndex && catchIndex < clearIndex,
  "the timeline append must sit inside a try introduced only after the send, with its catch before the queue clear",
);
// The catch swallows the append failure: nothing between it and the queue
// clear may return or throw, so a failed append can never skip the clear.
const catchToClear = serviceSource.slice(catchIndex, clearIndex);
assert.ok(
  !/\breturn\b|\bthrow\b/.test(catchToClear),
  "append failure must be swallowed (no return/throw between the catch and the queue clear)",
);
// The row is built through the SHARED strict schema with exactly the two
// allowed fields; no review content, patch text, path, or identifier may
// appear in the append payload.
const appendSegment = serviceSource.slice(appendIndex, catchIndex);
assert.match(appendSegment, /type: "plugin",/, "append must be a plugin-kind timeline item");
assert.match(appendSegment, /kind: reviewHandoffTimelineKind,/, "append must use the shared handoff kind constant");
assert.match(appendSegment, /version: reviewHandoffTimelineVersion,/, "append must use the shared handoff version constant");
const handoffPayload = serviceSource.match(/data: reviewHandoffTimelineSchema\.parse\(\{([\s\S]*?)\}\),/);
assert.ok(handoffPayload, "the timeline row must be validated through the shared reviewHandoffTimelineSchema.parse");
assert.match(
  handoffPayload[1],
  /commentCount: processedCommentIds\.length,/,
  "row data must carry the submitted batch's comment count",
);
assert.match(
  handoffPayload[1],
  /submittedAt: new Date\(\)\.toISOString\(\),/,
  "row data must carry the ISO submission timestamp",
);
for (const forbidden of ["filePath", "hunkPatch", "hunkHeader", "projectId", "workspaceId", "agentId", "cwd", "prompt", "content"]) {
  assert.ok(
    !handoffPayload[1].includes(forbidden),
    `timeline row data must not carry a ${forbidden} field`,
  );
}

// 8. Client-side async polling: the AI flows call the start RPCs and poll
//    pollAiReview every few seconds with a total cap, guarding each landing.
assert.match(clientHookSource, /const startExplainHunkAiRpc = useRpc\(startExplainHunkAi\);/, "client must bind startExplainHunkAi");
assert.match(clientHookSource, /const startRunReviewRpc = useRpc\(startRunReview\);/, "client must bind startRunReview");
assert.match(clientHookSource, /const pollAiReviewRpc = useRpc\(pollAiReview\);/, "client must bind pollAiReview");
assert.match(clientHookSource, /const \{ requestId \} = await startExplainHunkAiRpc\(/, "explainWithAgent must start, not block");
assert.match(clientHookSource, /const \{ requestId \} = await startRunReviewRpc\(/, "runAgentReview must start, not block");
assert.match(clientHookSource, /await pollUntilDone\(requestId, run, requestedLocale, /, "both flows must poll until done");
assert.match(
  clientHookSource,
  /const result = await pollAiReviewRpc\(\{ requestId, workspaceId: boundWorkspaceId, agentId: boundAgentId \}\);/i,
  "pollUntilDone must call pollAiReview with the request capability plus the bound workspace/agent",
);
assert.match(
  clientHookSource,
  /cwd: reviewCwd,\n\s+workspaceId,\n\s+scope,/,
  "both start calls must carry the bound workspaceId next to the reviewed cwd",
);
assert.match(clientHookSource, /pollUntilDone\(requestId, run, requestedLocale, workspaceId, agentId, /, "both flows must poll with the start-time workspace/agent binding");
assert.match(
  clientHookSource,
  /run !== analysisRunRef\.current \|\| localeRef\.current !== requestedLocale/,
  "each poll landing must re-check the analysis run and locale guards",
);
assert.match(clientHookSource, /READONLY_REVIEW_POLL_CAP_MS/, "poll must have a total cap");
assert.match(clientHookSource, /READONLY_REVIEW_POLL_INTERVAL_MS/, "poll must wait between polls");
assert.match(clientHookSource, /aiReviewPollTimeout/, "cap expiry must surface a clear error");
assert.match(
  i18nSource,
  /aiReviewPollTimeout: "AI 评审超过 5 分钟未完成，已停止等待。请重试。",/,
  "zh poll-timeout message must exist",
);
assert.match(
  i18nSource,
  /aiReviewPollTimeout: "AI review did not finish within 5 minutes; stopped waiting\. Try again\.",/,
  "en poll-timeout message must exist",
);

// 9. The combined config is valid against the daemon's own create_agent_request
//    wire schema — sample parent snapshot with a model (combined provider,
//    NO model key) and a bare parent (model null, provider alone).
const sampleParent = { provider: "omp", model: "deepseek/deepseek-v4-flash", thinkingOptionId: "high" };
const builtConfig = {
  provider: sampleParent.model ? `${sampleParent.provider}/${sampleParent.model}` : sampleParent.provider,
  ...(sampleParent.thinkingOptionId ? { thinkingOptionId: sampleParent.thinkingOptionId } : {}),
};
assert.equal(builtConfig.provider, "omp/deepseek/deepseek-v4-flash", "combined provider must join provider/model");
assert.ok(!("model" in builtConfig), "create config must not carry a separate model key");
const frame = CreateAgentRequestMessageSchema.parse({
  type: "create_agent_request",
  config: { ...builtConfig, cwd: "/tmp/review-deck-worktree" },
  requestId: "readonly-review-routing-test",
  initialPrompt: "read-only review prompt",
  autoArchive: true,
});
assert.equal(frame.config.provider, "omp/deepseek/deepseek-v4-flash");
assert.equal(frame.config.model, undefined, "schema-valid combined frame must carry no separate model");
assert.equal(frame.config.thinkingOptionId, "high");
assert.equal(frame.autoArchive, true);

const bareParent = { provider: "omp", model: null, thinkingOptionId: null };
const bareConfig = {
  provider: bareParent.model ? `${bareParent.provider}/${bareParent.model}` : bareParent.provider,
  ...(bareParent.thinkingOptionId ? { thinkingOptionId: bareParent.thinkingOptionId } : {}),
};
assert.equal(bareConfig.provider, "omp", "bare parent: provider alone");
const bareFrame = CreateAgentRequestMessageSchema.parse({
  type: "create_agent_request",
  config: { ...bareConfig, cwd: "/tmp/review-deck-worktree" },
  requestId: "readonly-review-routing-test-bare",
  initialPrompt: "read-only review prompt",
  autoArchive: true,
});
assert.equal(bareFrame.config.provider, "omp");
assert.equal(bareFrame.config.model, undefined, "bare parent: no model key and still schema-valid");
assert.equal(bareFrame.config.thinkingOptionId, undefined, "bare parent: thinkingOptionId omitted and still schema-valid");

console.log("readonly-review-routing: all assertions passed");
console.log("verdict: read-only reviews (startExplainHunkAi, startRunReview) pass a workspace-bound agent");
console.log("         gate (parent agent belongs to the claimed workspace, the claimed workspace's");
console.log("         directory is the reviewed worktree, the parent runs in that worktree), then create a");
console.log("         transient child agent and return a per-request capability (randomUUID — NEVER the");
console.log("         child's discoverable agent id) WITHOUT waiting; pollAiReview repeats the start-time");
console.log("         workspace/agent binding, waits in short windows and resolves the result (timeout =");
console.log("         still running, idle/error/permission = settled, unknown or mismatched = error).");
console.log("         config.provider is the combined 'provider/model' derived from the selected workspace");
console.log("         Agent snapshot (no separate model key, optional thinkingOptionId); the client polls");
console.log("         every few seconds with a 5-minute cap. Editing flows (processProjectReview handle.send,");
console.log("         client reviseCurrent/reviseFileFromComment send) hand the prompt to the visible stream");
console.log("         fire-and-forget and clear the submitted comments from Review Deck.");
console.log("         processProjectReview appends one best-effort, content-minimal version-1");
console.log("         review-deck-handoff timeline row (accepted send, then append, then queue clear): the");
console.log("         strict shared schema admits only commentCount + submittedAt, so the row records the");
console.log("         submission and never completion, review content, paths, or identifiers, and a failed");
console.log("         append is swallowed so the queue clear always runs.");
console.log("         The combined config parses against the daemon's CreateAgentRequestMessageSchema.");
