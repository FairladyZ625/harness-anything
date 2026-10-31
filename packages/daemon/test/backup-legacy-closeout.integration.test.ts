// harness-test-tier: integration
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { signInAt } from "./keycloak.fixtures.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sqliteLedgerPath } from "@harness-anything/storage";
import { readDaemonRegistry, serializeCanonicalEvent, sha256Text } from "@harness-anything/kernel";
import { serializeCanonicalEventUnchecked } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";

test("daemon backup and restore drill read historical task events with a retired fact override", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-backup-legacy-closeout-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    backupDir = path.join(parent, "backup"),
    shadowParent = path.join(parent, "drills"),
    repoId = "backup-legacy-closeout",
    taskId = "task_legacy_closeout";
  rosterRepo(rootDir, repoId);
  registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  const host = await openSignedInHost({ daemonId: repoId, userRoot });
  await host.attachmentsSettled();
  try {
    const taskWrite = await host.run(repoId, { kind: "task-create", taskId, title: "Legacy closeout" }, auth);
    assert.equal(taskWrite.outcome, "applied", JSON.stringify(taskWrite));

    const ledger = new DatabaseSync(sqliteLedgerPath(rootDir));
    let historicalEvent: Record<string, unknown>, acceptedRevision: number;
    try {
      const row = ledger
        .prepare("SELECT event_json FROM event WHERE json_extract(event_json, '$.payload.task.taskId') = ?")
        .get(taskId) as { readonly event_json: string } | undefined;
      assert.ok(row, "task creation event must be present in the canonical ledger");
      historicalEvent = JSON.parse(row.event_json) as Record<string, unknown>;
      const payload = historicalEvent.payload as { readonly task: Record<string, unknown> };
      payload.task.closeoutOverrides = { fact: false };
      const bytes = serializeCanonicalEventUnchecked(historicalEvent as never);
      ledger
        .prepare(
          "UPDATE event SET event_json = ?, digest = ? WHERE json_extract(event_json, '$.payload.task.taskId') = ?",
        )
        .run(bytes, `sha256:${sha256Text(bytes)}`, taskId);
      acceptedRevision = Number(
        (ledger.prepare("SELECT revision FROM ledger_meta WHERE singleton = 1").get() as { readonly revision: number })
          .revision,
      );
    } finally {
      ledger.close();
    }

    const backup = await host.admin({ kind: "backup", rootDir, backupDir }, auth);
    assert.equal(backup.ok, true, JSON.stringify(backup));
    assert.equal(backup.exitCode, 0);

    const drill = await host.admin({ kind: "restore-drill", rootDir, backupDir, shadowParent }, auth);
    assert.equal(drill.ok, true, JSON.stringify(drill));
    assert.equal(drill.exitCode, 0);
    assert.equal(drill.projection?.watermark, acceptedRevision);
    assert.match(drill.projection?.stateDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
    assert.throws(() => serializeCanonicalEvent(historicalEvent as never), /closeoutOverrides/u);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

async function openSignedInHost(input: Parameters<typeof openDaemonHost>[0]) {
  const repos = readDaemonRegistry({ userRoot: input.userRoot! }).repos;
  signInPolicyTestUser(
    input.userRoot!,
    "writer",
    repos.map((repo) => repo.repoId),
    "admin",
  );
  for (const repo of repos)
    if (repo.canonicalRoot !== null)
      signInAt(input.userRoot!, "writer", ["access-admin"], undefined, repo.canonicalRoot);
  return openDaemonHost(input);
}
