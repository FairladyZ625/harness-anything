---
schema: preset-document/v1
description: Create the standard planning, facts, and closeout scaffold for general software work.
whenToUse: Ordinary implementation, refactoring, docs, or test work when no narrower preset fits.
---

# Standard Task

Default software-coding preset. Use `--risk-tier low` for small low-risk changes (minimal plan/closeout, no review/consent; PR CI and submit risk floor still apply).

## Verified Profile (`--profile verified`)

Requires `artifacts/verification-receipt.json` (`commitSha`, `passed`, `failed: 0`, `timedOut: 0`, `unexecuted: 0`, `total`).
