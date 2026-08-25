// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY } from "../../src/domain/default-policy.ts";
import { parsePolicyDeclarationV1, validatePolicyDeclarationV1 } from "../../src/domain/policy.ts";
import { createEntityStore, explainEntityKind } from "../../src/index.ts";

test("the built-in policy registers its four kernel predicates and eight applicable Actions", () => {
  assert.deepEqual(validatePolicyDeclarationV1(DEFAULT_POLICY), []);
  assert.deepEqual(DEFAULT_POLICY.actions, [
    "task.consent",
    "task.complete",
    "execution.review",
    "decision.accept",
    "execution.release",
    "runtime.dispatch",
    "doc.submit",
    "task.closeout",
  ]);
  assert.deepEqual(
    [
      ...new Set(
        (DEFAULT_POLICY.rules ?? []).flatMap((rule) => rule.predicates.map((predicate) => predicate.predicate)),
      ),
    ],
    ["isOwner", "reviewIndependence", "hasCommandClass", "isExecutorOfExecution"],
  );
});

test("ha entity explain policy exposes the registered predicate vocabulary and Action set", () => {
  const explanation = explainEntityKind("policy");
  assert.deepEqual(explanation.policy, {
    predicates: ["isOwner", "isExecutorOfExecution", "hasCommandClass", "reviewIndependence"],
    actions: DEFAULT_POLICY.actions,
  });
  assert.equal(explanation.documentSchema.id, "policy/v1");
  assert.equal(explanation.id.refTemplate, "policy/{id}");
  assert.equal(explanation.documentSchema.fields.find(({ name }) => name === "version")?.type, "number");
});

test("policy schema rejects a missing version and invalid predicate arguments", () => {
  const withoutVersion = { ...DEFAULT_POLICY, version: undefined };
  assert.match(validatePolicyDeclarationV1(withoutVersion).join("\n"), /missing required field "version"/u);
  assert.throws(
    () => parsePolicyDeclarationV1({ ...DEFAULT_POLICY, predicates: [{ predicate: "isOwner", level: "L1" }] }),
    /isOwner does not accept arguments/u,
  );
});

test("the shared EntityStore accepts policy declarations without a policy-specific store", () => {
  const events: any[] = [];
  const blobs = new Map<string, Uint8Array>();
  const store = createEntityStore({
    read: () => ({ schema: "canonical-event-stream/v1", revision: events.length, events }),
    readContentBlob: (sha256) => blobs.get(sha256) ?? null,
  });
  const bundle = store.upsert({
    entityKind: "policy",
    entity: DEFAULT_POLICY,
    eventId: "event-policy-default",
    opId: "op-policy-default",
    workspaceRevision: 1,
    actor: { principal: { personId: "policy-test" }, executor: null },
    source: "local",
    occurredAt: "2026-08-25T00:00:00.000Z",
  });
  events.push(bundle.event);
  for (const blob of bundle.blobs) blobs.set(blob.sha256, Buffer.from(blob.body));
  assert.deepEqual(store.get("policy", "default")?.value, DEFAULT_POLICY);
  assert.throws(
    () =>
      store.upsert({
        entityKind: "policy",
        entity: { ...DEFAULT_POLICY, actions: [] },
        eventId: "event-policy-invalid",
        opId: "op-policy-invalid",
        workspaceRevision: 2,
        actor: { principal: { personId: "policy-test" }, executor: null },
        source: "local",
        occurredAt: "2026-08-25T00:00:00.000Z",
      }),
    /at least 1 item/u,
  );
});
