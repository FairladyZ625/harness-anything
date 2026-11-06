// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openSqliteEventStore } from "@harness-anything/storage";
import { consent as validSnapshotConsent } from "../src/protocol/daemon-protocol-validate-entities.ts";
import { signInAt } from "./keycloak.fixtures.ts";
import { fleetFixture, git, localAuthFixture, rawPeer } from "./fleet-tls-session.fixture.ts";
import type { FleetFrameV1 } from "../src/fleet/command-protocol.ts";

// dec_E610E1D99A39003886D1B5EE7C CH1: user consent through an authorized OAuth client.
test(
  "only a consent-scoped client can consent for a person and the event records its azp",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetFixture(t, undefined, "strict", true, "high");
    t.after(() => fixture.close());
    const { nodeId, repoId, taskId, executionId } = fixture.subject,
      reviewId = "review-fleet",
      packageDir = path.join(fixture.repo, "harness", fixture.packagePath),
      delivery = git(fixture.repo, "rev-parse", "HEAD"),
      applied = async (action: Parameters<typeof fixture.host.run>[1], auth = fixture.auth) => {
        const receipt = await fixture.host.run(repoId, action, auth);
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      };
    // An approved, independently reviewed cut: consent is the one thing completion still lacks.
    await applied({
      kind: "fact-record",
      taskId,
      statement: "The fleet fixture delivery exists.",
      evidenceSource: "harness/harness.yaml",
      confidence: "high",
      memoryClass: "episodic",
      memoryTags: [],
    });
    writeFileSync(
      path.join(packageDir, "closeout.md"),
      `# Closeout\n\n## Summary\n\nDelivery ${delivery} is ready.\n\n` +
        "## Verification\n\nThe consent source is exercised over TLS.\n\n" +
        "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNone.\n",
    );
    await applied({ kind: "doc-submit", paths: [`${fixture.packagePath}/closeout.md`] }, localAuthFixture());
    await applied({ kind: "task-submit", taskId, executionId, commitSha: delivery });
    mkdirSync(path.join(packageDir, "artifacts", "reports"), { recursive: true });
    writeFileSync(
      path.join(packageDir, "artifacts", "reports", "fleet.md"),
      `# Review ${reviewId}\n\nIndependent review findings recorded.\n`,
    );
    writeFileSync(
      path.join(fixture.repo, "review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Independent review passed.",
        evidenceChecked: ["tests"],
        findings: [],
        resolutions: [],
      }),
    );
    const review = { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: "review.json" } as const;
    const selfReview = await fixture.host.run(repoId, review, localAuthFixture());
    assert.equal(selfReview.code, "actor_unauthorized", JSON.stringify(selfReview));
    fixture.owners.keycloak.account("person-reviewer");
    fixture.owners.keycloak.permit("person-reviewer", repoId, ["task-review-execution"]);
    signInAt(fixture.userRoot, "person-reviewer");
    await applied(review, localAuthFixture());
    signInAt(fixture.userRoot, "person-owner");
    // The reviewer's report is accepted at the center, so completion finds no document left to carry.
    await applied({ kind: "doc-submit", taskId }, localAuthFixture());

    fixture.owners.keycloak.interactiveSession("person-owner", nodeId, fixture.owners.url, "web-no-consent", "web-bff");
    fixture.owners.keycloak.interactiveSession(
      "person-owner",
      nodeId,
      fixture.owners.url,
      "web-consent",
      "web-bff",
      "openid consent",
    );
    fixture.owners.keycloak.account("service-bff", "web-bff");
    fixture.owners.keycloak.interactiveSession(
      "service-bff",
      nodeId,
      fixture.owners.url,
      "service-consent",
      "web-bff",
      "consent",
    );
    const center = await fixture.center(),
      peer = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
      assigned = await peer.request({ schema: "fleet.repo.metadata.get/v1", messageId: "subject", repoId });
    assert.equal(assigned.schema, "fleet.repo.metadata.result/v1");
    if (assigned.schema !== "fleet.repo.metadata.result/v1") return;
    const fromNode = async (opId: string, action: Record<string, unknown>, token = "web-no-consent") => {
        const result = await peer.raw({
          schema: "fleet.task.command/v1",
          accessToken: token,
          messageId: opId,
          writerEpoch: assigned.writerEpoch,
          opId,
          repoId,
          taskId,
          action: { ...action, taskId, executionId },
          docChanges: null,
          mirrorBaseCut: null,
        } as FleetFrameV1);
        t.diagnostic(JSON.stringify({ opId, result }));
        return result.schema === "fleet.task.result/v1"
          ? { outcome: result.outcome, code: result.code }
          : { outcome: result.schema, code: result.schema === "fleet.error/v1" ? result.code : null };
      },
      before = fixture.eventCount();
    assert.deepEqual(await fromNode("service-consent", { kind: "task-review-consent", reviewId }, "service-consent"), {
      outcome: "fleet.error/v1",
      code: "human_confirmation_required",
    });
    assert.deepEqual(await fromNode("consent-from-node", { kind: "task-review-consent", reviewId }), {
      outcome: "op_rejected",
      code: "human_confirmation_required",
    });
    assert.equal(fixture.eventCount(), before, "the node's consent wrote nothing");
    assert.deepEqual(await fromNode("complete-without-consent", { kind: "task-complete" }), {
      outcome: "op_rejected",
      code: "consent_missing",
    });
    assert.equal(fixture.eventCount(), before, "the task stays open without a consent");

    assert.deepEqual(await fromNode("consent-scoped", { kind: "task-review-consent", reviewId }, "web-consent"), {
      outcome: "applied",
      code: null,
    });
    const store = openSqliteEventStore({ rootInput: fixture.repo, repoId, readOnly: true });
    try {
      const consent = store.events().findLast((event) => event.type === "review_consent_recorded");
      assert.ok(consent);
      const payload = consent.payload as { azp: string; consent: { actor: unknown; source: unknown } },
        value = payload.consent;
      assert.deepEqual(value.actor, { principal: { personId: "person-owner" }, executor: null });
      assert.equal(payload.azp, "web-bff");
      assert.equal(validSnapshotConsent(value), true, "the public v1 consent DTO retains its previous shape");
      assert.equal(Object.hasOwn(value, "azp"), false);
      assert.deepEqual(value.source, { kind: "node", nodeId });
    } finally {
      store.close();
    }
    git(fixture.repo, "update-ref", "refs/remotes/origin/main", delivery);
    await applied(
      { kind: "task-annotate", taskId, executionId, note: `merge_commit_sha:${delivery}` },
      localAuthFixture(),
    );
    assert.deepEqual(await fromNode("complete-after-consent", { kind: "task-complete" }), {
      outcome: "applied",
      code: null,
    });
  },
);

test("one BFF connection uses each request person without changing the node owner; revocation rejects writes", async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const { nodeId, repoId, taskId, executionId } = fixture.subject,
    keycloak = fixture.owners.keycloak;
  keycloak.account("person-b");
  keycloak.permit("person-b", repoId, ["repository-read", "task-annotate"]);
  for (const [person, token] of [
    ["person-owner", "web-a"],
    ["person-b", "web-b"],
  ])
    keycloak.interactiveSession(person!, nodeId, fixture.owners.url, token, "shared-bff");
  const center = await fixture.center(),
    peer = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
    metadata = await peer.request({ schema: "fleet.repo.metadata.get/v1", messageId: "users", repoId });
  assert.equal(metadata.schema, "fleet.repo.metadata.result/v1");
  if (metadata.schema !== "fleet.repo.metadata.result/v1") return;
  for (const [accessToken, personId] of [
    ["web-a", "person-owner"],
    ["web-b", "person-b"],
    ["web-a", "person-owner"],
  ]) {
    const identity = await peer.raw({
      schema: "fleet.repo.metadata.get/v1",
      messageId: `metadata-${accessToken}`,
      repoId,
      accessToken,
    });
    assert.equal(
      identity.schema === "fleet.repo.metadata.result/v1" && identity.personId,
      personId,
      JSON.stringify(identity),
    );
  }
  const annotate = (token: string, opId: string, extra = {}) =>
    peer.raw({
      schema: "fleet.task.command/v1",
      messageId: opId,
      opId,
      accessToken: token,
      writerEpoch: metadata.writerEpoch,
      repoId,
      taskId,
      action: { kind: "task-annotate", taskId, executionId, note: opId, ...extra },
      docChanges: null,
      mirrorBaseCut: null,
    });
  for (const [token, opId] of [
    ["web-a", "user-a-first"],
    ["web-b", "user-b"],
    ["web-a", "user-a-last"],
  ]) {
    const result = await annotate(token!, opId!);
    assert.equal(result.schema === "fleet.task.result/v1" && result.outcome, "applied", JSON.stringify(result));
  }
  assert.equal(fixture.owners.nodeOwner(nodeId), "person-owner", "BFF calls do not reassign the machine");
  const store = openSqliteEventStore({ rootInput: fixture.repo, repoId, readOnly: true });
  try {
    const events = store.events().filter((event) => event.type === "execution_annotated");
    assert.deepEqual(
      events.slice(-3).map((event) => event.actor.principal.personId),
      ["person-owner", "person-b", "person-owner"],
    );
  } finally {
    store.close();
  }
  keycloak.revoke("person-b", repoId, ["task-annotate"]);
  const before = fixture.eventCount(),
    revoked = await annotate("web-b", "revoked-grant");
  assert.equal(
    revoked.schema === "fleet.task.result/v1" && revoked.code,
    "authorization_denied",
    JSON.stringify(revoked),
  );
  keycloak.endInteractiveSession("web-a");
  const ended = await annotate("web-a", "revoked-session");
  assert.equal(ended.schema === "fleet.error/v1" && ended.code, "human_confirmation_required", JSON.stringify(ended));
  assert.equal(fixture.eventCount(), before, "revoked calls append nothing");
});
