# Security Review — Review Deck V2.0.4 scoped npm preparation

Date: 2026-10-10
Scope: V2.0.2 ReviewBatch dispatch, persistence/migration, timeline correlation, prompt construction, anchor preflight, and recovery UI; plus V2.0.4 scoped npm package metadata and files.

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
- `npm publish --access public --dry-run --json` — passed for `@mentalfl0w/review-deck@2.0.4`; the package contains the Registry overview, README image, manifest, and TypeScript source only.
- `npm view @mentalfl0w/review-deck` returned 404. The scoped version appears unpublished; registry ownership and npm authentication still need confirmation. No package was published.
Coverage percentages and interactive Paseo Host UI smoke were not measured; the repository has no coverage script and no configured/open Host UI runtime in this worktree.

## Security Review — V2.1.0 Finding and Captured Verification

Date: 2026-10-11  
Scope: deterministic Finding identity, AI Finding promotion, AI cache migration, ProcessRunner, ProcessVerificationStore, process evidence and human decisions.

### Findings

- **P2 — Concurrent starts could bypass process limits (resolved).** `ProcessVerificationService` now serializes admission, reserves global/workspace capacity before persistent writes, and reuses an existing live run for the same Finding. A concurrent-start regression test is present.
- **P2 — Interpreter aliases could bypass the exact-name denylist (resolved).** Captured mode uses a positive executable allowlist, rejects nested package-manager interpreter launches, and separately blocks inline evaluator flags. Regression cases cover `nodejs`, `python3.12`, `node -e`, and `yarn node -e`.
- **P2 — A leader close could cancel process-group SIGKILL escalation (resolved).** `ProcessRunner` now retains escalation until the original process group is observed gone or the confirmation window expires; it never reports an unconfirmed kill as a successful exit. Fake group-liveness and real process-group tests are present.
- **P2 — The reviewed target could change during metadata persistence before spawn (resolved).** The service rechecks Workspace path and target fingerprint immediately before spawn, refuses stale pending records, and records the observed completion fingerprint.
- **No remaining actionable findings** in the final read-only security review. No tests, builds, or linters were run by the reviewer.

### Residual risks and controls

- A change-and-restore between target fingerprint observations may evade stale marking. The UI and documentation state that the process is not a sandbox and that exit status is not a fix verdict.
- POSIX process groups cannot terminate descendants that deliberately escape with `setsid` or an equivalent mechanism. The confirmation UI, README, and Overview disclose this; captured execution is currently enabled only on macOS while Linux/Windows remain fail-closed until platform tests exist.
- The positive executable policy still runs approved test/build tools under workspace process permissions. Full command, workspace, target, and modification risk are shown before confirmation.

### Verification evidence

- `npm run typecheck` — passed.
- `npm test` — passed, including real process spawn/cancel, bounded output, target drift, AI Finding promotion, and cache migration.
- `npm pack --dry-run` — passed for local `@mentalfl0w/review-deck@2.0.4`; no package was published.
- Paseo Host UI visual smoke — `NOT_TESTED`; no configured/open Host UI runtime was available in this worktree.