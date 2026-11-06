# Third-party Web user-token API

A Web/BFF can use the existing Fleet TLS v1 API with a different user's Keycloak access token on every request. The BFF's registered device credential admits the connection; it does not choose the action's person or confer the device owner's repository permissions. HA independently introspects each request's token and uses the resulting person for its existing online RBAC and repository writer.

Configure the OAuth client in the center's Keycloak realm to issue personal access tokens with audience `harness-center` and the administrator-managed `harness_person_id` claim. HA checks active status, expiry, the configured realm issuer, audience, nonempty `azp`, and the enabled non-service-account user whose person attribute matches the token. A token issued for another center/realm or audience is rejected. Invitation admission additionally retains its invitation-specific client/person restriction.

For consent, assign the OAuth client the Keycloak client scope named `consent` (default or optional); if optional, request it during login. The introspected access token must include that exact space-delimited scope. This is separate from the person's RBAC permission to run `task-review-consent`; both are required. Missing scopes grant no consent authority. To revoke access immediately, revoke the relevant user session/token as well as changing future scope issuance; existing person permissions are evaluated again on writes.

## Calling the API

Use the normal Fleet TLS session handshake with the registered BFF node and machine credential. After admission, send newline-delimited Fleet v1 frames. Every protected frame carries that request user's `accessToken`, including reads. Do not change the center's local login, retain a previous user's token as connection state, or put identity/proof fields in `action`.

For example, after reading `fleet.repo.metadata.get/v1` to obtain the current writer epoch, a BFF sends:

```json
{
  "schema": "fleet.task.command/v1",
  "messageId": "request-unique-id",
  "opId": "request-unique-id",
  "repoId": "repository-id",
  "writerEpoch": 12,
  "accessToken": "THIS_REQUEST_USERS_ACCESS_TOKEN",
  "taskId": "task-id",
  "action": {
    "kind": "task-review-consent",
    "taskId": "task-id",
    "executionId": "execution-id",
    "reviewId": "review-id"
  },
  "docChanges": null,
  "mirrorBaseCut": null
}
```

This illustrates the existing wire contract, not a new HTTP endpoint. The authoritative schemas are in `packages/daemon/src/fleet/command-protocol.ts` and its imported frame types. The executable isolated example is `packages/daemon/test/fleet-user-token-api.integration.test.ts`: it uses one TLS connection for two users, verifies canonical event actors, revokes a grant/session, and exercises consent scope admission through the real host and writer.

The response is the existing `fleet.task.result/v1` receipt (or `fleet.error/v1` ingress failure). Absent/invalid personal tokens fail with `authentication_required`/`human_confirmation_required`; IdP outages retain the existing `keycloak_unavailable` error; RBAC and lifecycle failures retain their own receipt codes. Missing consent scope returns `human_confirmation_required`. Continue to use the existing operation IDs and receipt/retry contract; consent does not complete a task automatically. Request-supplied actor, azp or proof overrides are rejected by action validation.

## Consent and audit semantics

A consent-scoped OAuth client may confirm on behalf of the person holding the token. The client owns its confirmation UI and must display the correct current cut. HA does not prove the person saw that UI: any bearer holder can use the token. HA retains all current execution/review/content/submission checks, review settlement, independence and disposition rules.

The canonical `review_consent_recorded` / `review_consent_overridden` event records the verified person in `actor.principal.personId` and the token's issued-to client in optional `payload.azp`. That value identifies the client the token was issued to, not necessarily the bearer presenting it. Source remains the registered node; it is never rewritten to local. Machine credentials, service accounts and execution credentials cannot provide this consent authority. Local personal-session consent continues without an azp field.

The Fleet frame schema remains v1. The additive event audit field is optional so historical events without it remain readable, and persisted event readers tolerate additive fields. Public v1 consent snapshots retain their existing field set, including for clients in the previous version window. No alternate session store, confirmation challenge store, authorization evaluator or business write path is introduced. This entry enables existing repository actions subject to their own rules; it does not grant all human-sensitive actions a new proof or replace their separate contracts.
