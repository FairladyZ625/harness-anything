// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  daemonGenerationRecordPath,
  daemonMachineIdPath,
  publishNextDaemonGeneration,
  readOrCreateDaemonMachineId
} from "../src/index.ts";

test("machine identity is stable within one installation root and isolated across roots", () => {
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

test("generation publication is durable, endpoint-scoped, and strictly increasing", () => {
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

test("generation publication fails closed on corrupt or exhausted state", () => {
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
