// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  daemonGenerationRecordPath,
  daemonMachineIdPath,
  createDaemonGenerationWitness,
  prepareDaemonGenerationForServe,
  publishNextDaemonGeneration,
  readOrCreateDaemonMachineId
} from "../src/index.ts";

test("machine identity is stable within one installation root and isolated across roots", {
  skip: process.platform === "win32" ? "durable generation publication is unsupported on Windows" : false
}, () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "ha-machine-id-"));
  try {
    const firstRoot = path.join(parent, "first");
    const secondRoot = path.join(parent, "second");
    const first = readOrCreateDaemonMachineId(firstRoot);
    assert.equal(readOrCreateDaemonMachineId(firstRoot), first);
    assert.notEqual(readOrCreateDaemonMachineId(secondRoot), first);
    assert.equal(readFileSync(daemonMachineIdPath(firstRoot), "utf8"), `${first}\n`);
    if (process.platform !== "win32") assert.equal(statSync(daemonMachineIdPath(firstRoot)).mode & 0o777, 0o600);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("generation publication is durable, endpoint-scoped, and strictly increasing", {
  skip: process.platform === "win32" ? "durable generation publication is unsupported on Windows" : false
}, () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-generation-"));
  try {
    const machineId = readOrCreateDaemonMachineId(userRoot);
    const first = publishNextDaemonGeneration({
      userRoot,
      endpointIdentity: "/tmp/a.sock",
      machineId,
      daemonInstanceId: "daemon-a",
      now: () => new Date("2026-07-21T00:00:00.000Z")
    });
    const second = publishNextDaemonGeneration({
      userRoot,
      endpointIdentity: "/tmp/a.sock",
      machineId,
      daemonInstanceId: "daemon-b",
      now: () => new Date("2026-07-21T00:00:01.000Z")
    });
    const independent = publishNextDaemonGeneration({
      userRoot,
      endpointIdentity: "/tmp/b.sock",
      machineId,
      daemonInstanceId: "daemon-c"
    });
    assert.equal(first.daemonGeneration, 1);
    assert.equal(second.daemonGeneration, 2);
    assert.equal(independent.daemonGeneration, 1);
    assert.deepEqual(JSON.parse(readFileSync(daemonGenerationRecordPath(userRoot, "/tmp/a.sock"), "utf8")), second);
    if (process.platform !== "win32") {
      assert.equal(statSync(daemonGenerationRecordPath(userRoot, "/tmp/a.sock")).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("generation publication fails closed on corrupt or exhausted state", {
  skip: process.platform === "win32" ? "durable generation publication is unsupported on Windows" : false
}, () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-generation-corrupt-"));
  const endpointIdentity = "/tmp/a.sock";
  try {
    const machineId = readOrCreateDaemonMachineId(userRoot);
    const target = daemonGenerationRecordPath(userRoot, endpointIdentity);
    writeFileSync(target, "{}\n", "utf8");
    assert.throws(() => publishNextDaemonGeneration({ userRoot, endpointIdentity, machineId, daemonInstanceId: "daemon" }), /invalid daemon generation record/u);
    writeFileSync(target, `${JSON.stringify({
      schema: "daemon-generation-record/v1",
      machineId,
      endpointIdentity,
      daemonGeneration: Number.MAX_SAFE_INTEGER,
      daemonInstanceId: "daemon",
      publishedAt: "2026-07-21T00:00:00.000Z"
    })}\n`, "utf8");
    assert.throws(() => publishNextDaemonGeneration({ userRoot, endpointIdentity, machineId, daemonInstanceId: "daemon" }), /space exhausted/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("generation witness observes its record and loses currency after replacement", {
  skip: process.platform === "win32" ? "durable generation publication is unsupported on Windows" : false
}, async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-witness-"));
  const endpointIdentity = "/tmp/witness.sock";
  try {
    const machineId = readOrCreateDaemonMachineId(userRoot);
    const first = publishNextDaemonGeneration({ userRoot, endpointIdentity, machineId, daemonInstanceId: "daemon-a" });
    const witness = createDaemonGenerationWitness({
      userRoot,
      endpointIdentity,
      machineId,
      daemonGeneration: first.daemonGeneration
    });
    assert.doesNotThrow(() => witness.assertCurrent());
    const lockPath = `${daemonGenerationRecordPath(userRoot, endpointIdentity)}.lock`;
    const result = await witness.runExclusive(async () => {
      assert.equal(existsSync(lockPath), true);
      return "operation-complete";
    });
    assert.equal(result, "operation-complete");
    assert.equal(existsSync(lockPath), false, "runExclusive resolved before releasing its lock");
    publishNextDaemonGeneration({ userRoot, endpointIdentity, machineId, daemonInstanceId: "daemon-b" });
    assert.throws(() => witness.assertCurrent(), /daemon generation witness lost.*observed .*\/2/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("explicit Windows generation witness creation fails closed without publishing", () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-witness-win32-"));
  try {
    assert.throws(() => createDaemonGenerationWitness({
      userRoot,
      endpointIdentity: "pipe:witness",
      machineId: "machine-a",
      daemonGeneration: 1,
      platform: "win32"
    }), /DAEMON_GENERATION_DURABILITY_UNSUPPORTED/u);
    assert.equal(existsSync(daemonGenerationRecordPath(userRoot, "pipe:witness")), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("Windows fails closed before publishing machine identity or daemon generation", () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-generation-win32-"));
  const machinePath = daemonMachineIdPath(userRoot);
  const generationPath = daemonGenerationRecordPath(userRoot, "pipe:daemon");
  try {
    assert.throws(
      () => readOrCreateDaemonMachineId(userRoot, "win32"),
      /DAEMON_GENERATION_DURABILITY_UNSUPPORTED/u
    );
    assert.equal(existsSync(machinePath), false);
    assert.throws(
      () => publishNextDaemonGeneration({
        userRoot,
        endpointIdentity: "pipe:daemon",
        machineId: "machine-a",
        daemonInstanceId: "daemon-a",
        platform: "win32"
      }),
      /DAEMON_GENERATION_DURABILITY_UNSUPPORTED/u
    );
    assert.equal(existsSync(generationPath), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("Windows daemon startup degrades to legacy generation mode without throwing or publishing", () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-start-win32-"));
  try {
    let preparation: ReturnType<typeof prepareDaemonGenerationForServe> | undefined;
    assert.doesNotThrow(() => {
      preparation = prepareDaemonGenerationForServe({
        userRoot,
        endpointIdentity: "pipe:daemon",
        daemonInstanceId: "daemon-a",
        platform: "win32"
      });
    });
    assert.deepEqual(preparation, {
      mode: "legacy",
      diagnostic: "DAEMON_GENERATION_DURABILITY_UNSUPPORTED"
    });
    assert.equal(existsSync(daemonMachineIdPath(userRoot)), false);
    assert.equal(existsSync(daemonGenerationRecordPath(userRoot, "pipe:daemon")), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
