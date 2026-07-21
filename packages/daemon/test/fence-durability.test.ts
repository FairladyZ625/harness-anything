// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("durability reader accepts only a continuous schema-valid prefix and tolerates one torn tail", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-durability-tail-read-"));
  try {
    const valid = `${JSON.stringify(durabilityRecord("commit-valid"))}\n`;
    for (const [name, tail] of [
      ["partial", '{"schema":"single-authority'],
      ["malformed-newline", "{not-json}\n"],
      ["schema-invalid-newline", `${JSON.stringify({ schema: "not-an-audit-record" })}\n`]
    ] as const) {
      const ledgerPath = path.join(root, `${name}.jsonl`);
      await writeFile(ledgerPath, `${valid}${tail}`, "utf8");
      assert.deepEqual(
        (await readSingleAuthorityDurabilityLedger(ledgerPath)).map(({ commitSha }) => commitSha),
        ["commit-valid"]
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durability reader fails closed on a malformed or schema-invalid middle record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-durability-middle-"));
  try {
    const first = `${JSON.stringify(durabilityRecord("commit-first"))}\n`;
    const last = `${JSON.stringify(durabilityRecord("commit-last"))}\n`;
    for (const [name, middle] of [
      ["malformed", "{not-json}\n"],
      ["schema-invalid", `${JSON.stringify({ arbitrary: "parseable-json" })}\n`]
    ] as const) {
      const ledgerPath = path.join(root, `${name}.jsonl`);
      await writeFile(ledgerPath, `${first}${middle}${last}`, "utf8");
      await assert.rejects(
        readSingleAuthorityDurabilityLedger(ledgerPath),
        /invalid single-authority durability ledger/u
      );
      const before = await readFile(ledgerPath);
      await assert.rejects(
        new SingleAuthorityDurabilityLedger(ledgerPath).append(durabilityRecord("must-not-append")),
        /invalid single-authority durability ledger/u
      );
      assert.equal((await readFile(ledgerPath)).equals(before), true, "fail-closed append changed a corrupt ledger");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("append repairs a torn final record before writing the next durable record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-durability-tail-repair-"));
  try {
    for (const [name, tail] of [
      ["partial", '{"schema":"single-authority'],
      ["malformed-newline", "{not-json}\n"]
    ] as const) {
      const ledgerPath = path.join(root, `${name}.jsonl`);
      await writeFile(
        ledgerPath,
        `${JSON.stringify(durabilityRecord("commit-before"))}\n${tail}`,
        "utf8"
      );
      const ledger = new SingleAuthorityDurabilityLedger(ledgerPath);
      await ledger.append(durabilityRecord("commit-after"));
      assert.deepEqual(
        (await readSingleAuthorityDurabilityLedger(ledgerPath)).map(({ commitSha }) => commitSha),
        ["commit-before", "commit-after"]
      );
      assert.equal((await readFile(ledgerPath, "utf8")).includes("not-json"), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("append rejects parseable JSON that is not a durability audit record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-durability-schema-"));
  try {
    const ledger = new SingleAuthorityDurabilityLedger(path.join(root, "durability.jsonl"));
    for (const invalid of [
      { arbitrary: "parseable-json" },
      { ...durabilityRecord("bad-stage"), completedStages: ["NOT_FSYNCED"] },
      { ...durabilityRecord("bad-bound"), backupBoundSatisfied: "true" },
      { ...durabilityRecord("extra-key"), ungoverned: true }
    ]) {
      await assert.rejects(
        ledger.append(invalid as never),
        /invalid single-authority durability audit record/u
      );
    }
    assert.deepEqual(await readSingleAuthorityDurabilityLedger(ledger.path), []);
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
    const round = process.argv[3];
    for (let index = 0; index < 10000; index += 1) {
      await ledger.append({
        schema: "single-authority-durability-audit/v1",
        profile: "SINGLE_AUTHORITY_BOUNDED_RPO",
        commitSha: "round-" + round + "-commit-" + index,
        completedStages: ["CANONICAL_OBJECTS_FSYNCED", "CANONICAL_REF_FSYNCED", "OPERATION_INDEX_FSYNCED", "ORIGIN_RESULT_DURABLE", "BACKUP_HOOK_RECORDED"],
        backupWatermark: "round-" + round + "-watermark-" + index,
        backupBoundSatisfied: true
      });
      process.stdout.write(String(index) + "\\n");
    }
  `;
  const childEnv = { ...process.env, FORCE_COLOR: "0" };
  delete childEnv.NO_COLOR;
  let activeChild: ReturnType<typeof spawn> | undefined;
  try {
    for (let round = 0; round < 6; round += 1) {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", childScript, moduleUrl, ledgerPath, String(round)],
        { stdio: ["ignore", "pipe", "pipe"], env: childEnv }
      );
      activeChild = child;
      let acknowledged = -1;
      let buffered = "";
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stderr?.on("data", (chunk) => reject(new Error(String(chunk))));
        child.once("exit", (code, signal) => {
          if (acknowledged < 24) reject(new Error(`durability child exited before acknowledgement 24 (code=${code}, signal=${signal})`));
        });
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
      const exited = once(child, "exit");
      assert.equal(child.kill("SIGKILL"), true);
      await exited;
      activeChild = undefined;

      const afterCrash = await readSingleAuthorityDurabilityLedger(ledgerPath);
      for (let index = 0; index <= acknowledged; index += 1) {
        assert.equal(
          afterCrash.some((record) => record.commitSha === `round-${round}-commit-${index}`),
          true,
          `lost fsynced round-${round}-commit-${index}`
        );
      }
      await new SingleAuthorityDurabilityLedger(ledgerPath).append(durabilityRecord(`round-${round}-restart`));
    }

    const restarted = new SingleAuthorityDurabilityLedger(ledgerPath);
    await restarted.append(durabilityRecord("commit-after-restart"));
    assert.equal(
      (await readSingleAuthorityDurabilityLedger(ledgerPath)).at(-1)?.commitSha,
      "commit-after-restart"
    );
  } finally {
    if (activeChild?.exitCode === null && activeChild.signalCode === null) activeChild.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

function durabilityRecord(commitSha: string) {
  return {
    schema: "single-authority-durability-audit/v1" as const,
    profile: "SINGLE_AUTHORITY_BOUNDED_RPO" as const,
    commitSha,
    completedStages: [
      "CANONICAL_OBJECTS_FSYNCED",
      "CANONICAL_REF_FSYNCED",
      "OPERATION_INDEX_FSYNCED",
      "ORIGIN_RESULT_DURABLE",
      "BACKUP_HOOK_RECORDED"
    ] as const,
    backupWatermark: `watermark-${commitSha}`,
    backupBoundSatisfied: true
  };
}
