# Review Deck

Review Deck is a human-in-the-loop code review plugin for Paseo. It presents a workspace's Git changes file by file and hunk by hunk, lets reviewers anchor comments to exact lines or hunks, and routes selected comments to an Agent in the same workspace.

Review state and queued comments are stored locally under `~/.paseo/review-deck/`. When a reviewer starts an AI Review or submits a comment batch, Review Deck sends the relevant diff context or selected comments to a Paseo Agent and its configured provider. Background workspace badges use counts rather than comment text or patches.

Review Deck requires a Paseo workspace, a Git repository, and an Agent. It uses that Agent's provider and model without separate credentials. Paseo 0.10.0+ is supported; npm installation requires Paseo 0.11.0+.

Reviewers submit comments by workspace and track per-comment outcomes. Comments remain queued until the matching Agent turn reports `COMPLETED`.

Stale or ambiguous anchors are never guessed. If delivery is uncertain, Review Deck never resends automatically. A reviewer may inspect the timeline and release the claim; duplicate work can result.

Rule and structured AI findings can be edited into normal project comments after human confirmation. The server rechecks the current target and unique anchor; existing Hunk comments are not overwritten.

Interactive verification remains in the workspace Terminal. Captured mode accepts approved test/build tools and runs direct executable plus argv only after exact-command confirmation.

Output is capped at 32 KiB and kept in memory only. Original/observed fingerprints mark persistent drift; change-and-restore may evade comparison. POSIX group cancellation cannot reach escaped descendants, so abandoned runs require host inspection. Exit status is never a pass/fail verdict. Captured mode currently runs only on macOS; other platforms fail closed.