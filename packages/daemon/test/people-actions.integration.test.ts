// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    const roleChanged = await cell.run(
      {
        kind: "people-set-role",
        personId: "person_alice",
        role: "owner",
        commandClass: ["admin"],
      },
      binding,
    );
    assert.equal(roleChanged.outcome, "applied");
    const afterRole = parsePeopleRosterDocument(readFileSync(path.join(root, "harness/people.yaml"), "utf8"));
    assert.deepEqual(afterRole.people.find(({ personId }) => personId === "person_alice")?.roles, ["owner"]);
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
      3,
    );
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
