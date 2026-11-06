# Entity Action explanation: the authorization precheck contract

`repo.entity.actions.explain` is the only public authorization precheck surface for
Entity Actions. A client asks it what the authenticated person may do with a set of
Entity objects right now. The answer is advisory: it is not a write, a lock, an
approval, or a reusable permit. Every real write is authorized again inside the
writer at its current canonical cut.

This page covers the wire shape, the identity precondition, `allowed` / `denied` /
`unavailable` results and their stable reason codes, freshness, and capability
discovery. The schema remains `entity-action-explain-request/v1` and
`entity-action-explanation/v1`.

## Calling it

Transport method: `repo.entity.actions.explain`. The daemon also carries a protocol
descriptor for `POST /api/entities/actions/explain`; that descriptor is a route
declaration, not a claim that a standalone public HTTP listener is deployed. A
third-party BFF uses the daemon transport or the authenticated ingress that owns the
user's token.

Object mode evaluates every action in the target Entity's declared catalog:

```json
{
  "repo": { "repoId": "registered-repository-id" },
  "payload": {
    "schema": "entity-action-explain-request/v1",
    "mode": "object",
    "entityKind": null,
    "refs": ["task/task-id"]
  }
}
```

- `mode` is `object` or `catalog`.
- In `object` mode `entityKind` must be `null`; the kind is derived from each ref.
- `refs` holds 1–500 EntityRefs. Duplicate refs are allowed and cached within the
  request; the response preserves input order.
- In `catalog` mode `entityKind` names one registered kind and `refs` is empty or
  contains only that same kind.

Catalog mode discovers actions without evaluating them:

```json
{
  "repo": { "repoId": "registered-repository-id" },
  "payload": {
    "schema": "entity-action-explain-request/v1",
    "mode": "catalog",
    "entityKind": "task",
    "refs": []
  }
}
```

Payload fields other than these (and the reserved `executor`) are rejected at the
wire shape. That includes `actor`, `personId`, `role`, and `cut`: a caller cannot
choose the principal or the cut it is evaluated at. `executor` is reserved for
execution-bound agents and is described under the identity precondition below.

## Identity precondition

The request is evaluated for the actor established by the daemon-authenticated
transport, never for a value in the payload. `authorizationDecision.actor` names
that principal.

- **A binding is required.** A request without one fails with
  `authentication_required`; it is not answered as an anonymous or empty result.
- **The Keycloak credential must match the actor.** The daemon evaluates that
  person's own grants through the existing `AuthorizationProvider`. If no online
  credential is attached, actions are denied with `keycloak_evaluation_missing`
  rather than allowed by default.
- **`executor` never changes the person.** An execution-bound agent may claim an
  agent executor only when it names the authenticated `RuntimeSession` or matches
  the current task lease. Any other claim fails with `executor_binding_invalid`.
  A Web client should not send `executor`.
- **A service account, node credential, or execution credential is not a Web user.**
  Those identities do not make a request carry a person's grants, and they are not
  a substitute for forwarding each user's own access token.

## Response

The result is an `entity-action-explanation/v1` set. `mode` is `object`, `failure`,
or `catalog`. `evaluatedAtCut` is `canonical:<sourceRevision>` for object and
failure results and `null` for catalog results.

Each object action row carries:

| Field                        | Meaning                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                     | Canonical declaration: `kind`, `id`, `catalogRef`, `contractVersion`, `explain`, and `syntax` (`usage` plus input fields).                                                                            |
| `target`                     | The evaluated EntityRef and its revision.                                                                                                                                                             |
| `available`                  | `true` only when the authorization decision is `allowed` **and** every declared object/actor/cut criterion is met.                                                                                    |
| `criteria` / `unmetCriteria` | The declaration order, each criterion's status (`met`, `unmet`, `invocation-required`, `not-evaluated`), failure code, and next actions; `unmetCriteria` is the exact projection of the `unmet` rows. |
| `authorizationDecision`      | `policyRef`, `actor`, `subject`, `bindingsUsed`, `outcome` (`allowed` or `denied`), stable `reasonCodes`, `nextActions`, and `evaluatedAtCut`.                                                        |
| `evaluatedAtCut`             | The one canonical cut used for this row; it equals the set cut.                                                                                                                                       |

`available` is not a statement that the concrete invocation would succeed. It
covers only this authority evaluation plus the object/actor/cut criteria the
catalog declares. It does not prove that the user saw a confirmation screen, that
the client supplied valid parameters, or that a later write will still be allowed.

### Three answers and their codes

| Answer      | Shape                                                                                                                | What the client should do                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed     | `authorizationDecision.outcome === "allowed"` and all criteria met                                                   | Enable the action for this object; the write can still be refused by its own criteria at write time.                                                  |
| Denied      | `authorizationDecision.outcome === "denied"` or an `unmet` criterion, with non-empty `reasonCodes` and `nextActions` | Keep the action disabled and show the reason/next action. Do not retry blindly.                                                                       |
| Unavailable | The read fails with error code `keycloak_unavailable`                                                                | Treat authority as temporarily unavailable: no action is allowed, show a retry path, and use bounded backoff with jitter. Never fall back to enabled. |

A provider that is reachable but answers HTTP 5xx (for example 503 while starting or
overloaded) is also unavailable, not a denial: it carries no policy decision. An
authorization `401`/`403` is a real denial; a malformed `2xx` body is a defect.

Stable codes a Web caller can see in `authorizationDecision.reasonCodes`:

| Code                          | Source                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `keycloak_allowed`            | The person's grant authorizes this action on this resource.                         |
| `keycloak_denied`             | The authority answered and the person has no covering grant.                        |
| `unknown_scope`               | The authority does not know the requested scope; deny and surface the contract gap. |
| `authentication_required`     | The credential does not identify the actor the decision is for.                     |
| `keycloak_evaluation_missing` | The daemon had no online decision for the row; fail closed.                         |
| `entity_kind_not_found`       | An artifact action named a kind the runtime cannot resolve.                         |

`policyRef` (for example `keycloak-policy@1`) identifies the authority's decision
semantics. It is not a policy epoch and must not be compared for recency.
Transport failures are not decision rows: they surface as `keycloak_unavailable`
and no `allowed` row is produced. A malformed authority response is a defect and
is not reclassified as an outage.

### Typed failures

A target that cannot be evaluated is a typed failure subject rather than a
fabricated decision:

| Failure code                 | Meaning                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `invalid_entity_ref`         | The ref is not a registered EntityRef.                                                                           |
| `entity_not_found`           | The Task, Person, or Squad does not exist at the cut.                                                            |
| `unsupported_explain_target` | The ref parses but this surface does not evaluate that kind (for example `fact/...` or an external harness ref). |
| `projection_pending`         | The projection has not reached the canonical cut; retry after it catches up.                                     |

## Freshness

Every object request evaluates the online authority again. There is no
cross-request allow cache keyed by person, object, or cut.

- One request uses one canonical cut. All rows and the set carry the same
  `evaluatedAtCut`, and the decision's `evaluatedAtCut` equals its row's.
- If the cut moves between resolving the authority decisions and reading the
  projection, the read fails with `projection_pending` instead of mixing cuts.
- Revoking a grant changes the next explanation even when the ledger cut has not
  moved. Revoking the writer-side capability does not retroactively make an old
  response a permit.
- Session revocation is a Keycloak session concern. This release re-evaluates
  grants per request, but the center adapter may reuse a user-token validity result
  until that token's expiry. Do not treat the precheck as proof that a session is
  still live; sensitive writes still pass through the writer's own check.
- Every real write re-authorizes inside the writer at the current cut. A precheck
  response is never accepted as a write proof, idempotency key, or delegation.

## Capability discovery

Use `mode: "catalog"` to learn what a deployment supports before rendering
buttons:

- the full declared action inventory for `task`, `person`, `squad`, and every
  runtime artifact kind that declares an action catalog;
- each action's `id`, contract version, usage, input fields, and criteria;
- `available: null`, `authorizationDecision: null`, `evaluatedAtCut: null`, and
  `not-evaluated` criteria, because catalog mode never evaluates authority.

Never enable an action from the catalog alone. Catalog mode also cannot authorize a
target that does not exist yet (for example a `task-create` repository target);
create/intent actions without an object target stay discovery-only until an object
explain can name the target.

Object explain currently covers `task`, `person`, and `squad`. Artifact kinds are
discoverable in catalog mode but an artifact object ref returns
`unsupported_explain_target`; do not treat that failure as a denial of the action.
Unknown catalog kinds fail the request with `invalid_command`.

## Compatibility and authority

The request and response schema ids above are the current version. Any future
change follows the current-plus-previous compatibility window: a new schema id is
introduced additively, the previous version keeps working for the window, and the
old adapter is deleted at the end of it. This page describes the current v1 shape
only; it is a client-facing index, not a second schema.

The canonical declarations are
[`entity-action-explanation.ts`](../packages/kernel/src/domain/entity-action-explanation.ts),
[`task-action-explanation-read.ts`](../packages/daemon/src/task-action-explanation-read.ts),
and the protocol descriptor in
[`daemon-protocol-gui-reads.ts`](../packages/daemon/src/protocol/daemon-protocol-gui-reads.ts).
The contract test is
[`entity-action-explain-contract.integration.test.ts`](../packages/daemon/test/entity-action-explain-contract.integration.test.ts).
