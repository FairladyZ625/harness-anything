// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  actionForDaemonMethod,
  commandClassForAction,
  parseDaemonGuiReadResult,
  parseDaemonRpcParams,
} from "../src/protocol/daemon-protocol.contract.ts";
import { repositoryReadDescriptor } from "../src/repository-read-contract.ts";
import { parseFleetFrame } from "../src/fleet/command-protocol.ts";

test("public context, reckoning and policy reads declare repository reader admission", () => {
  for (const method of ["repo.tasks.runtimeContext.read", "repo.reckoning.signals.read", "repo.policy.metadata.read"]) {
    assert.ok(repositoryReadDescriptor(method));
    assert.equal(commandClassForAction(actionForDaemonMethod(method, {}).kind), "repo-read");
  }
});

test("reckoning rejects invalid windows and accepts a deterministic reporting cut", () => {
  const repo = { repoId: "studio" };
  for (const payload of [
    { generatedAt: "invalid" },
    { windowHours: 0 },
    { windowHours: -1 },
    { windowHours: 8785 },
    { windowHours: Number.NaN },
    { until: "2026-11-02T00:00:00.000Z" },
  ])
    assert.equal(parseDaemonRpcParams("repo.reckoning.signals.read", { repo, payload }).ok, false);
  assert.equal(
    parseDaemonRpcParams("repo.reckoning.signals.read", {
      repo,
      payload: { generatedAt: "2026-11-02T00:00:00.000Z", windowHours: 0.5 },
    }).ok,
    true,
  );
});

test("registration input cannot claim creator, status, runtime, policy, or digest", () => {
  const draft = { skillId: "report", version: "1.0.0", body: "Report verified evidence." };
  assert.equal(parseDaemonRpcParams("daemon.skillEval.version.register", draft).ok, true);
  for (const field of ["createdBy", "status", "runtime", "policy", "digest", "canReview"])
    assert.equal(parseDaemonRpcParams("daemon.skillEval.version.register", { ...draft, [field]: "forged" }).ok, false);
});

test("read result contracts reject fabricated policy and malformed signal receipts", () => {
  assert.throws(() =>
    parseDaemonGuiReadResult("repo.policy.metadata.read", { ok: true, roles: [], actions: [], cells: {} }),
  );
  assert.throws(() =>
    parseDaemonGuiReadResult("repo.reckoning.signals.read", { ok: true, schema: "reckoning-signals/v1", signals: [] }),
  );
});

test("fleet policy metadata uses the existing operational read frame", () => {
  const frame = {
    schema: "fleet.operational.read/v1",
    messageId: "metadata-1",
    repoId: "studio",
    method: "repo.policy.metadata.read",
    payload: {},
  };
  assert.deepEqual(parseFleetFrame(frame), frame);
  assert.throws(() => parseFleetFrame({ ...frame, method: "repo.settings.update" }));
});
