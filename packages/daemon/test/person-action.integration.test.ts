// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { initRepo } from "./migration-import.fixtures.ts";

const explainMethod = "repo.entity.actions.explain" as const,
  explainSchema = "entity-action-explain-request/v1" as const,
  ownerActor = { principal: { personId: "person_zeyu" }, executor: null } as const;

test("Person Actions share catalog execution, exact refusal attribution, and explain parity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-person-action-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    let now = "2026-09-01T01:00:00.000Z";
    cell = await openRepoCell({
      repoId: workspaceId("person-action"),
      rootDir: canonicalRoot(root),
      ownerId: "person-action-test",
      now: () => now,
    });
    const ownerBinding = { actor: ownerActor, source: "local" as const },
      added = await cell.run(
        {
          kind: "people-add",
          personId: "person_alice",
          displayName: "Alice",
          role: "administrator",
          commandClass: ["admin"],
          idempotencyKey: "person-action-add-alice",
        },
        ownerBinding,
      );
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    assert.deepEqual(added.effects, ["people-event/people_changed"]);
    assert.deepEqual(added.updatedProjection, {
      kind: "person",
      ref: "person/person_alice",
      revision: added.revision,
    });

    const catalog = await cell.read(
        explainMethod,
        { schema: explainSchema, mode: "catalog", refs: ["person"] },
        ownerBinding,
      ),
      object = await cell.read(
        explainMethod,
        { schema: explainSchema, mode: "object", refs: ["person/person_zeyu"] },
        ownerBinding,
      );
    assert.deepEqual(
      catalog.subjects[0]?.actions.map(({ action }) => action.id),
      ["add", "set-role", "bind", "delegate", "revoke-delegation", "remove"],
    );
    assert.equal(
      catalog.subjects[0]?.actions.every(({ available }) => available === null),
      true,
    );
    const explained = new Map(object.subjects[0]?.actions.map((row) => [row.action.id, row]));
    assert.equal(explained.get("add")?.available, false);
    assert.deepEqual(explained.get("add")?.unmetCriteria, [
      {
        ref: "people-roster/add.invariants",
        failureCode: "invalid_people_action",
        explain: "The Person identity is new and the resulting roster preserves owner and administrator authority.",
      },
    ]);
    assert.equal(explained.get("delegate")?.available, true);
    assert.equal(explained.get("remove")?.available, false);
    assert.match(explained.get("remove")?.nextActions[0] ?? "", /bootstrap creator/u);
    assert.doesNotThrow(() => parseDaemonGuiReadResult(explainMethod, object));

    const beforeOwnerRefusal = peopleEventCount(root),
      ownerRemoval = await cell.run(
        { kind: "people-remove", personId: "person_zeyu", idempotencyKey: "reject-owner-removal" },
        ownerBinding,
      );
    assert.equal(ownerRemoval.outcome, "op_rejected");
    assert.equal(ownerRemoval.code, "invalid_people_action");
    assert.deepEqual(ownerRemoval.unmetCriteria, [
      {
        ref: "people-roster/remove.invariants",
        failureCode: "invalid_people_action",
        explain: "The Person exists, is not the bootstrap owner, and removal retains an enabled administrator.",
      },
    ]);
    assert.match(ownerRemoval.nextActions?.[0] ?? "", /bootstrap creator person_zeyu cannot be removed/u);
    assert.equal(peopleEventCount(root), beforeOwnerRefusal);

    const delegated = await cell.run(
      {
        kind: "people-delegate",
        tokenId: "det_person_action_1",
        runtimeSessionId: "runtime_person_action",
        action: ["execution.start"],
        expiresAt: "2026-09-01T03:00:00.000Z",
        idempotencyKey: "person-action-delegate",
      },
      ownerBinding,
    );
    assert.equal(delegated.outcome, "applied", JSON.stringify(delegated));
    now = "2026-09-01T01:30:00.000Z";
    const beforeRevokeRefusal = peopleEventCount(root),
      aliceBinding = {
        actor: { principal: { personId: "person_alice" }, executor: null },
        source: "local" as const,
      },
      foreignRevoke = await cell.run(
        {
          kind: "people-revoke-delegation",
          tokenId: "det_person_action_1",
          idempotencyKey: "person-action-foreign-revoke",
        },
        aliceBinding,
      );
    assert.equal(foreignRevoke.outcome, "op_rejected", JSON.stringify(foreignRevoke));
    assert.equal(foreignRevoke.code, "invalid_people_action");
    assert.deepEqual(foreignRevoke.unmetCriteria, [
      {
        ref: "people-roster/revoke-delegation.invariants",
        failureCode: "invalid_people_action",
        explain: "The DelegatedExecutionToken exists and is owned by the authenticated issuing Person.",
      },
    ]);
    assert.match(foreignRevoke.nextActions?.[0] ?? "", /Only DelegatedExecutionToken issuer person_zeyu/u);
    assert.equal(peopleEventCount(root), beforeRevokeRefusal);
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function peopleEventCount(root: string): number {
  return makeTaskEventStore({ repoId: "person-action", rootDir: root })
    .read()
    .events.filter(({ schema }) => schema === "people-event/v1").length;
}
