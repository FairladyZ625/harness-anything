// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeDaemonGenerationAxesV1,
  decodeDaemonTerminalGenerationAxesV1
} from "../src/index.ts";

test("daemon generation axes codec accepts omitted, partial, and full projections", () => {
  assert.deepEqual(decodeDaemonGenerationAxesV1({}), {});
  assert.deepEqual(decodeDaemonGenerationAxesV1({ daemonGeneration: 7 }), { daemonGeneration: 7 });
  assert.deepEqual(decodeDaemonGenerationAxesV1({
    machineId: "machine-installation-a",
    daemonGeneration: 8,
    runtimeRegistrationId: "runtime-registration-a",
    connectionId: "connection-a"
  }), {
    machineId: "machine-installation-a",
    daemonGeneration: 8,
    runtimeRegistrationId: "runtime-registration-a",
    connectionId: "connection-a"
  });
  assert.deepEqual(decodeDaemonTerminalGenerationAxesV1({ leaseGeneration: 2 }), { leaseGeneration: 2 });
});

test("daemon generation axes codec rejects invalid identifiers and counters", () => {
  for (const value of [
    { machineId: "" },
    { runtimeRegistrationId: "  " },
    { daemonGeneration: 0 },
    { daemonGeneration: 1.5 },
    { leaseGeneration: Number.MAX_SAFE_INTEGER + 1 }
  ]) assert.throws(() => decodeDaemonTerminalGenerationAxesV1(value));
});
