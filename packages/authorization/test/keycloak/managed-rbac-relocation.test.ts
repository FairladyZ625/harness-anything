// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readManagedRbacRelocationBundle,
  writeManagedRbacRelocationBundle,
} from "../../src/keycloak/managed-rbac-relocation.ts";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";

test("relocation bundle hashes realm credentials, center secret, and optional edge journal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-relocation-")),
    directory = path.join(root, "bundle"),
    journal = { joins: [{ nodeId: "edge-17", admission: { state: "accepted" } }] };
  try {
    writeManagedRbacRelocationBundle(directory, {
      realm: "harness",
      realmJson: JSON.stringify({ realm: "harness", users: [{ credentials: [{ secretData: "hash" }] }] }),
      centerClientSecret: "test-center-secret",
      edgeJoinJournal: journal,
    });
    const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest).sort(), ["entries", "realm", "schema"]);
    assert.deepEqual(
      manifest.entries.map(({ name }: { readonly name: string }) => name),
      ["center-client-secret", "edge-join-journal.json", "realm.json"],
    );
    assert.equal(JSON.stringify(manifest).includes(root), false);
    assert.ok(manifest.entries.every(({ sha256 }: { readonly sha256: string }) => /^[a-f0-9]{64}$/u.test(sha256)));
    assert.deepEqual(readManagedRbacRelocationBundle(directory), {
      manifest,
      realm: "harness",
      realmJson: JSON.stringify({ realm: "harness", users: [{ credentials: [{ secretData: "hash" }] }] }),
      centerClientSecret: "test-center-secret",
      edgeJoinJournal: journal,
    });
    for (const name of ["manifest.json", "realm.json", "center-client-secret", "edge-join-journal.json"])
      assert.equal(statSync(path.join(directory, name)).mode & 0o077, 0);
  } finally {
    removeTempRepository(root);
  }
});

test("relocation bundle refuses modified data before import can consume it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-rbac-relocation-tamper-")),
    directory = path.join(root, "bundle");
  try {
    writeManagedRbacRelocationBundle(directory, {
      realm: "harness",
      realmJson: JSON.stringify({ realm: "harness", users: [] }),
      centerClientSecret: "test-center-secret",
    });
    writeFileSync(
      path.join(directory, "realm.json"),
      JSON.stringify({ realm: "harness", users: [{ username: "tampered" }] }),
    );
    assert.throws(() => readManagedRbacRelocationBundle(directory), { code: "rbac_relocation_integrity_failed" });
  } finally {
    removeTempRepository(root);
  }
});
