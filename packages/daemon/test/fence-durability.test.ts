// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  DurabilityBoundUnsatisfiedError,
  SingleAuthorityDurabilityLedger,
  readSingleAuthorityDurabilityLedger,
  runSingleAuthorityBoundedRpoCommit
} from "../src/index.ts";

test("bounded-RPO commit audits every fsync boundary and withholds COMMITTED when backup is unsatisfied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-durability-order-"));
  const ledgerPath = path.join(root, "durability.jsonl");
  const calls: string[] = [];
  try {
    const ledger = new SingleAuthorityDurabilityLedger(ledgerPath);
    const operation = {
      fenceWitness: { assertHeld: async () => undefined },
      ledger,
      backupHook: {
        capture: async () => {
          calls.push("backup");
          return { watermark: "backup-pending", boundSatisfied: false };
        }
      },
      prepareCanonicalObjects: async () => {
        calls.push("prepare");
        return { commitSha: "commit-1" };
      },
      fsyncCanonicalObjects: async () => calls.push("fsync-objects"),
      publishCanonicalRef: async () => calls.push("publish-ref"),
      fsyncCanonicalRef: async () => calls.push("fsync-ref"),
      fsyncOperationIndex: async () => calls.push("fsync-op-index"),
      persistOriginResult: async () => calls.push("persist-origin")
    };

    await assert.rejects(runSingleAuthorityBoundedRpoCommit(operation), DurabilityBoundUnsatisfiedError);
    assert.deepEqual(calls, [
      "prepare",
      "fsync-objects",
      "publish-ref",
      "fsync-ref",
      "fsync-op-index",
      "persist-origin",
      "backup"
    ]);
    assert.deepEqual(await readSingleAuthorityDurabilityLedger(ledgerPath), [{
      schema: "single-authority-durability-audit/v1",
      profile: "SINGLE_AUTHORITY_BOUNDED_RPO",
      commitSha: "commit-1",
      completedStages: [
        "CANONICAL_OBJECTS_FSYNCED",
        "CANONICAL_REF_FSYNCED",
        "OPERATION_INDEX_FSYNCED",
        "ORIGIN_RESULT_DURABLE",
        "BACKUP_HOOK_RECORDED"
      ],
      backupWatermark: "backup-pending",
      backupBoundSatisfied: false
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kill -9 and restart preserves every fsynced durability audit record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-durability-kill-"));
  const ledgerPath = path.join(root, "durability.jsonl");
  const moduleUrl = pathToFileURL(path.resolve("packages/daemon/src/fence/index.ts")).href;
  const childScript = `
    const { SingleAuthorityDurabilityLedger } = await import(process.argv[1]);
    const ledger = new SingleAuthorityDurabilityLedger(process.argv[2]);
    for (let index = 0; index < 200; index += 1) {
      await ledger.append({
        schema: "single-authority-durability-audit/v1",
        profile: "SINGLE_AUTHORITY_BOUNDED_RPO",
        commitSha: "commit-" + index,
        completedStages: ["CANONICAL_OBJECTS_FSYNCED", "CANONICAL_REF_FSYNCED", "OPERATION_INDEX_FSYNCED", "ORIGIN_RESULT_DURABLE", "BACKUP_HOOK_RECORDED"],
        backupWatermark: "watermark-" + index,
        backupBoundSatisfied: true
      });
      console.log(index);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript, moduleUrl, ledgerPath], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let acknowledged = -1;
  let buffered = "";
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stderr?.on("data", (chunk) => reject(new Error(String(chunk))));
      child.stdout?.on("data", (chunk) => {
        buffered += String(chunk);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line !== "") acknowledged = Number.parseInt(line, 10);
        }
        if (acknowledged >= 24) resolve();
      });
    });
    assert.equal(child.kill("SIGKILL"), true);
    await once(child, "exit");

    const afterCrash = await readSingleAuthorityDurabilityLedger(ledgerPath);
    assert.equal(acknowledged >= 24, true);
    for (let index = 0; index <= acknowledged; index += 1) {
      assert.equal(afterCrash.some((record) => record.commitSha === `commit-${index}`), true, `lost fsynced commit-${index}`);
    }

    const restarted = new SingleAuthorityDurabilityLedger(ledgerPath);
    await restarted.append({
      schema: "single-authority-durability-audit/v1",
      profile: "SINGLE_AUTHORITY_BOUNDED_RPO",
      commitSha: "commit-after-restart",
      completedStages: [
        "CANONICAL_OBJECTS_FSYNCED",
        "CANONICAL_REF_FSYNCED",
        "OPERATION_INDEX_FSYNCED",
        "ORIGIN_RESULT_DURABLE",
        "BACKUP_HOOK_RECORDED"
      ],
      backupWatermark: "watermark-after-restart",
      backupBoundSatisfied: true
    });
    assert.equal(
      (await readSingleAuthorityDurabilityLedger(ledgerPath)).at(-1)?.commitSha,
      "commit-after-restart"
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
