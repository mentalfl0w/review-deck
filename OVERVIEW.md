# Review Deck

Review Deck is a human-in-the-loop code review plugin for Paseo. It presents a workspace's Git changes file by file and hunk by hunk, lets reviewers anchor comments to exact lines or hunks, and routes selected comments to an Agent in the same workspace.

Review state and queued comments are stored locally under `~/.paseo/review-deck/`. When a reviewer starts an AI Review or submits a comment batch, Review Deck sends the relevant diff context or selected comments to a Paseo Agent and its configured provider. Background workspace badges use counts rather than comment text or patches.

Review Deck requires a Paseo workspace, a Git repository, and an Agent configured in Paseo. It uses that Agent's provider and model; it does not require separate model credentials. The plugin supports Paseo 0.10.0 and later. Installing the npm package through Paseo requires Paseo 0.11.0 or later.

Reviewers can submit comments by workspace, track per-comment outcomes, and keep comments queued until the matching Agent turn reports `COMPLETED`. Stale or ambiguous anchors are not guessed. If message delivery is uncertain, Review Deck does not resend automatically; the reviewer can inspect the Agent timeline and explicitly release the claim, which may result in duplicate work. Verification commands run in a workspace terminal only after user confirmation, and the user reviews their output.