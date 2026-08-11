# Gate receipts

Place governance-exported receipt JSON files here. P2 uses the repository-visible
HMAC placeholder in `receipt-verify.mjs`; governance must replace that verifier
before receipts become trust-bearing.

Anti-entropy review receipts use `scope: replay:<sorted-module-list>`, bind the
pull request HEAD in `headSha`, and require `verdict: approved`. Pull requests
reference them with `Anti-Entropy-Receipt: tools/gates/receipts/<file>.json`.
