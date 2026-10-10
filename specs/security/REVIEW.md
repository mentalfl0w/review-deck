# Security Review — Review Deck V2.0.2

Date: 2026-10-10
Scope: V2.0.2 worktree diff from `4fe8e04c362224b2f5b37dcad399c9b7f1d638a2`; ReviewBatch dispatch, persistence/migration, timeline correlation, prompt construction, anchor preflight, and recovery UI.

## Findings

- **P2 — Turn association could be confused by a replayed Batch marker (resolved).** Initial review found that a marker alone could settle a batch when its `turnId` was missing. `server/ReviewService.ts::findReviewBatchTimelineMessage` now requires a current public timeline entry whose `turnId` matches the ending event and whose message identity matches when the SDK exposes one. Batches without delivery metadata are never correlated through Turn/Archive events; they require explicit duplicate-risk release. Mismatched or unavailable associations keep the claim active. Regression coverage is in `tests/review-batch-service.test.ts`.
- **No unresolved high-confidence findings** in the reviewed dispatch, persistence, prompt, or recovery paths. Comment deletion remains gated on an explicit `COMPLETED` outcome from a correlated Batch turn.

## Residual risks and controls

- `AgentHandle.send()` returns `Promise<void>` and does not expose a stable rejection discriminator. A rejected promise may mean an explicit refusal or a lost ACK after delivery. All send failures therefore remain `unknown`; the plugin never parses error text or retries automatically. Unknown claims stay active until timeline proof or explicit user release.
- Paseo provides no atomic send-if-idle operation. The server refreshes and revalidates the Agent immediately before dispatch, but status may change between refresh and daemon handling. The README documents this TOCTOU limit; prompts require a fresh target/fingerprint check before edits.
- Version-1 Batch migration validates the full store, preserves exact bytes in a non-overwritable read-only backup, and refuses malformed or conflicting backups. Legacy batches receive no fabricated message identity and remain manual-only.
- User-controlled comments, patches, project/workspace metadata, and anchors are JSON-quoted in prompts. Current paths flow through the existing Git/AnchorEngine validation; stale or ambiguous selected anchors prevent dispatch.

## Verification evidence

- `npm run typecheck` — passed.
- `npm test` — passed, including ReviewBatch service/store, prompt/parser, Agent registry, workspace grouping, and legacy replay/manual-release regressions.
- `npm pack --dry-run` — passed for `review-deck@2.0.2`.

Coverage percentages and interactive Paseo Host UI smoke were not measured; the repository has no coverage script and no configured/open Host UI runtime in this worktree.