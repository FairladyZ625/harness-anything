# Gate receipts

Place base-side governance decision receipt JSON files here. G32/G33 retain the
P2 repository-visible verifier seam because these receipts do not bind the PR
HEAD and therefore have no self-reference.

Anti-entropy review receipts must not be committed here. They use
`scope: replay:<sorted-module-list>`, bind the pull request HEAD in `headSha`,
require `verdict: approved`, and are base64url-encoded directly in the PR body:

`Anti-Entropy-Token: <base64url>`

G35 reads `ANTI_ENTROPY_HMAC_KEY` from the workflow secret in CI or from the
environment during local development. A missing key fails closed.
