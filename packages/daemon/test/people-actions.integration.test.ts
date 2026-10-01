// harness-test-tier: integration
import assert from "node:assert/strict";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, parsePeopleRosterDocument } from "@harness-anything/kernel";
import { initRepo, actor, bootstrapPerson, git } from "./migration-import.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";

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
    const binding = withRoleBinding({ actor, source: "local" as const }, "owner");
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
    await waitForFixturePublication(cell, added.opId, withRoleBinding({ actor, source: "local" }, "owner"));
    // Role policies and RoleBindings have no write Action any more: Keycloak grants replaced them.
    for (const retired of [
      { kind: "people-bind", actor: "person:person_alice", role: "arbiter", target: "settings/repository" },
      { kind: "people-set-role", personId: "person_alice", role: "reviewer", commandClass: ["repo-read"] },
    ])
      await assert.rejects(cell.run(retired as never, binding));
    const afterRetired = parsePeopleRosterDocument(readFileSync(path.join(root, "harness/people.yaml"), "utf8"));
    assert.deepEqual(afterRetired.people.find(({ personId }) => personId === "person_alice")?.roles, ["dispatcher"]);
    assert.deepEqual(afterRetired.bindings, []);
    const removed = await cell.run({ kind: "people-remove", personId: "person_alice" }, binding);
    assert.equal(removed.outcome, "applied");
    await waitForFixturePublication(cell, removed.opId, withRoleBinding({ actor, source: "local" }, "owner"));
    const finalRoster = parsePeopleRosterDocument(readFileSync(path.join(root, "harness/people.yaml"), "utf8"));
    assert.equal(
      finalRoster.people.some(({ personId }) => personId === "person_alice"),
      false,
    );
    assert.equal(
      makeTaskEventReader({ repoId: "people-actions", rootDir: root })
        .read()
        .events.filter(({ schema }) => schema === "people-event/v1").length,
      2,
    );
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("People Action commands cannot remove the bootstrap owner", async () => {
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
    const binding = withRoleBinding({ actor, source: "local" as const }, "owner");
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
    await waitForFixturePublication(cell, addedAdmin.opId, withRoleBinding({ actor, source: "local" }, "owner"));
    const ownerRemoval = await cell.run({ kind: "people-remove", personId: "person_zeyu" }, binding);
    assert.equal(ownerRemoval.outcome, "op_rejected");
    assert.equal(ownerRemoval.code, "invalid_people_action");

    assert.equal(
      makeTaskEventReader({ repoId: "people-invariants", rootDir: root })
        .read()
        .events.filter(({ schema }) => schema === "people-event/v1").length,
      1,
    );
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("People Action commands cannot remove the last enabled admin", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-people-last-admin-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    const alice = {
      ...bootstrapPerson,
      personId: "person_alice",
      displayName: "Alice",
      roles: ["administrator"],
      credentials: [],
    };
    initRepo(
      root,
      `${JSON.stringify(
        {
          schema: "harness-people/v1",
          people: [bootstrapPerson, alice],
          roles: [
            { roleId: "owner", commandClasses: ["repo-read"] },
            { roleId: "administrator", commandClasses: ["admin"] },
          ],
        },
        null,
        2,
      )}\n`,
    );
    cell = await openRepoCell({
      repoId: workspaceId("people-last-admin"),
      rootDir: canonicalRoot(root),
      ownerId: "people-daemon",
      now: () => "2026-08-27T02:15:00.000Z",
    });
    const removed = await cell.run(
      { kind: "people-remove", personId: "person_alice" },
      withRoleBinding({ actor, source: "local" as const }, "owner"),
    );
    assert.equal(removed.outcome, "op_rejected");
    assert.equal(removed.code, "invalid_people_action");
    assert.equal(
      makeTaskEventReader({ repoId: "people-last-admin", rootDir: root })
        .read()
        .events.filter(({ schema }) => schema === "people-event/v1").length,
      0,
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
    rmSync(path.join(root, "harness/people.yaml"));
    git(root, "add", "harness/people.yaml");
    git(root, "commit", "-qm", "remove roster for null transition fixture");
    cell = await openRepoCell({
      repoId: workspaceId("people-missing"),
      rootDir: canonicalRoot(root),
      ownerId: "people-daemon",
      now: () => "2026-08-27T02:20:00.000Z",
    });
    const created = await cell.run(
      {
        kind: "people-add",
        personId: "person_recovery_owner",
        displayName: "Recovery Owner",
        role: "owner",
        commandClass: ["admin"],
      },
      withRoleBinding({ actor, source: "local" as const }, "owner"),
    );
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, withRoleBinding({ actor, source: "local" }, "owner"));
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

test("People Action commands hydrate closed file and inline packets", async () => {
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
    const binding = withRoleBinding({ actor, source: "local" as const }, "owner");
    writeFileSync(
      path.join(root, "people-add.json"),
      JSON.stringify({
        personId: "person_alice",
        displayName: "Alice",
        role: "dispatcher",
        commandClass: ["repo-write"],
      }),
    );
    const added = await cell.run({ kind: "people-add", fromFile: "people-add.json" }, binding);
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    await waitForFixturePublication(cell, added.opId, binding);
    const removed = await cell.run(
      { kind: "people-remove", jsonInput: JSON.stringify({ personId: "person_alice" }) },
      binding,
    );
    assert.equal(removed.outcome, "applied", JSON.stringify(removed));
    await waitForFixturePublication(cell, removed.opId, binding);
    writeFileSync(
      path.join(root, "people-invalid.json"),
      JSON.stringify({ personId: "person_bob", unsupported: true }),
    );
    const rejected = await cell.run({ kind: "people-remove", fromFile: "people-invalid.json" }, binding);
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "invalid_command");
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
      binding = withRoleBinding({ actor: delegatingActor, source: "local" as const }, "owner"),
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
    await waitForFixturePublication(cell, issued.opId, withRoleBinding({ actor, source: "local" }, "owner"));
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
    await waitForFixturePublication(cell, revoked.opId, withRoleBinding({ actor, source: "local" }, "owner"));
    roster = parsePeopleRosterDocument(readFileSync(path.join(root, "harness/people.yaml"), "utf8"));
    assert.equal(roster.delegatedExecutionTokens[0]?.revokedAt, now);
    assert.equal(
      makeTaskEventReader({ repoId: "people-delegation", rootDir: root })
        .read()
        .events.filter(({ schema }) => schema === "people-event/v1").length,
      2,
    );
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
