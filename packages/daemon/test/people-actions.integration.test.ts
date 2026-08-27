// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, parsePeopleRosterDocument } from "../../kernel/src/index.ts";
import { initRepo, actor } from "./migration-import.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";

test("People Action commands are the canonical write surface for people.yaml", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-people-actions-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("people-actions"),
      rootDir: canonicalRoot(root),
      ownerId: "people-daemon",
      now: () => "2026-08-27T02:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    const added = await cell.run(
      {
        kind: "people-add",
        personId: "person_alice",
        displayName: "Alice",
        role: "dispatcher",
        commandClass: ["repo-write", "repo-read"],
        credentialKind: "email-address",
        credentialIssuer: "example.invalid",
        credentialSubject: "alice@example.invalid",
      },
      binding,
    );
    assert.equal(added.outcome, "applied");
    const bound = await cell.run(
      {
        kind: "people-bind",
        actor: "person:person_alice",
        role: "arbiter",
        target: "settings/repository",
      },
      binding,
    );
    assert.equal(bound.outcome, "applied");
    const malformedBinding = await cell.run(
      {
        kind: "people-bind",
        actor: "person:person_alice",
        role: "arbiter",
        target: "not-an-entity-ref",
      },
      binding,
    );
    assert.equal(malformedBinding.outcome, "op_rejected");
    assert.equal(malformedBinding.code, "invalid_people_action");
    assert.match(malformedBinding.nextAction ?? "", /RoleBinding target must be an EntityRef/u);
    const ownerPromotion = await cell.run(
      {
        kind: "people-set-role",
        personId: "person_alice",
        role: "owner",
        commandClass: ["admin"],
      },
      binding,
    );
    assert.equal(ownerPromotion.outcome, "op_rejected");
    assert.equal(ownerPromotion.code, "invalid_people_action");
    assert.match(ownerPromotion.nextAction ?? "", /owner role is reserved for the bootstrap creator/u);
    const roleChanged = await cell.run(
      {
        kind: "people-set-role",
        personId: "person_alice",
        role: "reviewer",
        commandClass: ["repo-read"],
      },
      binding,
    );
    assert.equal(roleChanged.outcome, "applied");
    const afterRole = parsePeopleRosterDocument(readFileSync(path.join(root, "harness/people.yaml"), "utf8"));
    assert.deepEqual(afterRole.people.find(({ personId }) => personId === "person_alice")?.roles, ["reviewer"]);
    assert.deepEqual(afterRole.bindings, [
      {
        actor: { kind: "person", id: "person_alice" },
        role: "arbiter",
        target: "settings/repository",
        source: "declared",
        expiresAt: null,
      },
    ]);
    const removed = await cell.run({ kind: "people-remove", personId: "person_alice" }, binding);
    assert.equal(removed.outcome, "applied");
    const finalRoster = parsePeopleRosterDocument(readFileSync(path.join(root, "harness/people.yaml"), "utf8"));
    assert.equal(
      finalRoster.people.some(({ personId }) => personId === "person_alice"),
      false,
    );
    assert.equal(
      makeTaskEventStore({ repoId: "people-actions", rootDir: root })
        .read()
        .events.filter(({ schema }) => schema === "people-event/v1").length,
      4,
    );
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("People Action commands cannot remove the last admin or downgrade the bootstrap owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-people-invariants-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("people-invariants"),
      rootDir: canonicalRoot(root),
      ownerId: "people-daemon",
      now: () => "2026-08-27T02:10:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    const addedAdmin = await cell.run(
      {
        kind: "people-add",
        personId: "person_alice",
        displayName: "Alice",
        role: "administrator",
        commandClass: ["admin"],
        credentialKind: "email-address",
        credentialIssuer: "example.invalid",
        credentialSubject: "alice@example.invalid",
      },
      binding,
    );
    assert.equal(addedAdmin.outcome, "applied");
    const ownerPolicyChanged = await cell.run(
      {
        kind: "people-set-role",
        personId: "person_zeyu",
        role: "owner",
        commandClass: ["repo-read"],
      },
      binding,
    );
    assert.equal(ownerPolicyChanged.outcome, "applied");

    const lastAdminRemoval = await cell.run({ kind: "people-remove", personId: "person_alice" }, binding);
    assert.equal(lastAdminRemoval.outcome, "op_rejected");
    assert.equal(lastAdminRemoval.code, "invalid_people_action");
    assert.match(lastAdminRemoval.nextAction ?? "", /at least one enabled person with admin authority/u);

    const ownerRemoval = await cell.run({ kind: "people-remove", personId: "person_zeyu" }, binding);
    assert.equal(ownerRemoval.outcome, "op_rejected");
    assert.equal(ownerRemoval.code, "invalid_people_action");
    assert.match(ownerRemoval.nextAction ?? "", /bootstrap creator person_zeyu cannot be removed/u);

    const ownerDowngrade = await cell.run(
      {
        kind: "people-set-role",
        personId: "person_zeyu",
        role: "reviewer",
        commandClass: ["repo-read"],
      },
      binding,
    );
    assert.equal(ownerDowngrade.outcome, "op_rejected");
    assert.equal(ownerDowngrade.code, "invalid_people_action");
    assert.match(ownerDowngrade.nextAction ?? "", /must retain the owner role/u);
    assert.equal(
      makeTaskEventStore({ repoId: "people-invariants", rootDir: root })
        .read()
        .events.filter(({ schema }) => schema === "people-event/v1").length,
      2,
    );
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("People Action commands create people.yaml through the null roster transition", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-people-missing-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("people-missing"),
      rootDir: canonicalRoot(root),
      ownerId: "people-daemon",
      now: () => "2026-08-27T02:20:00.000Z",
    });
    rmSync(path.join(root, "harness/people.yaml"));
    const created = await cell.run(
      {
        kind: "people-add",
        personId: "person_recovery_owner",
        displayName: "Recovery Owner",
        role: "owner",
        commandClass: ["admin"],
      },
      { actor, source: "local" as const },
    );
    assert.equal(created.outcome, "applied");
    const roster = parsePeopleRosterDocument(readFileSync(path.join(root, "harness/people.yaml"), "utf8"));
    assert.deepEqual(
      roster.people.map(({ personId }) => personId),
      ["person_recovery_owner"],
    );
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("People Action commands hydrate closed from-file packets inside the workspace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-people-packets-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("people-packets"),
      rootDir: canonicalRoot(root),
      ownerId: "people-daemon",
      now: () => "2026-08-27T02:30:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    writeFileSync(
      path.join(root, "people-add.json"),
      JSON.stringify({
        personId: "person_alice",
        displayName: "Alice",
        role: "dispatcher",
        commandClass: ["repo-write"],
      }),
    );
    assert.equal((await cell.run({ kind: "people-add", fromFile: "people-add.json" }, binding)).outcome, "applied");
    writeFileSync(
      path.join(root, "people-role.json"),
      JSON.stringify({ personId: "person_alice", role: "reviewer", commandClass: ["repo-read"] }),
    );
    assert.equal(
      (await cell.run({ kind: "people-set-role", fromFile: "people-role.json" }, binding)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(root, "people-binding.json"),
      JSON.stringify({
        actor: "person:person_alice",
        role: "arbiter",
        target: "settings/repository",
        expiresAt: null,
      }),
    );
    assert.equal(
      (await cell.run({ kind: "people-bind", fromFile: "people-binding.json" }, binding)).outcome,
      "applied",
    );
    writeFileSync(path.join(root, "people-remove.json"), JSON.stringify({ personId: "person_alice" }));
    assert.equal(
      (await cell.run({ kind: "people-remove", fromFile: "people-remove.json" }, binding)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(root, "people-invalid.json"),
      JSON.stringify({ personId: "person_bob", unsupported: true }),
    );
    const rejected = await cell.run({ kind: "people-remove", fromFile: "people-invalid.json" }, binding);
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "invalid_command");
    assert.match(rejected.nextAction ?? "", /unsupported people input fields/u);
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("People delegated tokens issue and revoke through the canonical people event writer", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-people-delegation-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    let now = "2026-08-27T02:00:00.000Z";
    cell = await openRepoCell({
      repoId: workspaceId("people-delegation"),
      rootDir: canonicalRoot(root),
      ownerId: "people-daemon",
      now: () => now,
    });
    const delegatingActor = { ...actor, principal: { personId: "person_zeyu" } },
      binding = { actor: delegatingActor, source: "local" as const },
      issued = await cell.run(
        {
          kind: "people-delegate",
          tokenId: "det_owner_runtime_1",
          runtimeSessionId: "runtime_1",
          action: ["execution.start", "doc.submit"],
          expiresAt: "2026-08-27T03:00:00.000Z",
        },
        binding,
      );
    assert.equal(issued.outcome, "applied", JSON.stringify(issued));
    let roster = parsePeopleRosterDocument(readFileSync(path.join(root, "harness/people.yaml"), "utf8"));
    assert.deepEqual(roster.delegatedExecutionTokens, [
      {
        schema: "delegated-execution-token/v1",
        tokenId: "det_owner_runtime_1",
        issuer: { personId: delegatingActor.principal.personId },
        delegate: { runtimeSessionId: "runtime_1" },
        allowedActions: ["doc.submit", "execution.start"],
        issuedAt: now,
        expiresAt: "2026-08-27T03:00:00.000Z",
        revokedAt: null,
      },
    ]);
    assert.match(issued.evidence ?? "", /det_owner_runtime_1/u);

    now = "2026-08-27T02:30:00.000Z";
    const revoked = await cell.run({ kind: "people-revoke-delegation", tokenId: "det_owner_runtime_1" }, binding);
    assert.equal(revoked.outcome, "applied", JSON.stringify(revoked));
    roster = parsePeopleRosterDocument(readFileSync(path.join(root, "harness/people.yaml"), "utf8"));
    assert.equal(roster.delegatedExecutionTokens[0]?.revokedAt, now);
    assert.equal(
      makeTaskEventStore({ repoId: "people-delegation", rootDir: root })
        .read()
        .events.filter(({ schema }) => schema === "people-event/v1").length,
      2,
    );
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
