// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonGuiReadResponse, parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { serializeAgentEntityCatalog } from "../src/protocol/agent-entity-gui-contract.ts";

// The daemon added `hostAccess` / `hostAccessSource` in 9737f8f784. An already-running GUI
// bundle carries the previous field list: the client-inbound read must ignore the additive
// fields inside the current/previous protocol window, while the daemon exit and the write
// serializer keep the exact shape.
const futureAgentRow = {
  id: "terra",
  name: "Terra",
  runtimes: [{ type: "codex" }],
  instance: null,
  permissionMode: null,
  hostAccess: "operator",
  hostAccessSource: "default",
  role: "worker",
  layer: "user",
  retirement: null,
  futureOptionalField: { enabled: true },
};
const futureCatalog = { schema: "agent-entity-catalog/v1", ok: true, agents: [futureAgentRow] };

test("client inbound ignores an additive Agent read field and logs it once", (t) => {
  const warn = t.mock.method(console, "warn", () => undefined),
    first = parseDaemonGuiReadResponse("repo.agent.entities.list", futureCatalog),
    second = parseDaemonGuiReadResponse("repo.agent.entities.list", futureCatalog);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(warn.mock.calls.length, 1, "the same ignored field is reported once, not on every poll");
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /futureOptionalField/u);
});

test("the daemon exit and the write serializer keep the closed Agent shape", () => {
  assert.throws(() => parseDaemonGuiReadResult("repo.agent.entities.list", futureCatalog), /unknown; remove it/u);
  assert.throws(() => serializeAgentEntityCatalog(futureCatalog), /unknown; remove it/u);
});

test("client inbound still rejects a missing required Agent field", () => {
  const { name: _name, ...missingName } = futureAgentRow;
  assert.throws(
    () =>
      parseDaemonGuiReadResponse("repo.agent.entities.list", {
        ...futureCatalog,
        agents: [missingName],
      }),
    /missing required field "name"/u,
  );
});

test("client inbound ignores unknown nested retirement fields within the same window", (t) => {
  t.mock.method(console, "warn", () => undefined);
  const parsed = parseDaemonGuiReadResponse("repo.agent.entities.list", {
    ...futureCatalog,
    agents: [
      {
        ...futureAgentRow,
        retirement: { retiredAt: "2026-11-08T00:00:00.000Z", reason: "superseded", futureRetirementField: 1 },
      },
    ],
  });
  assert.equal(parsed.ok, true);
});

test("the same client-inbound tolerance covers every read shape, not only Agent rows", (t) => {
  t.mock.method(console, "warn", () => undefined);
  const systemStatus = {
    schema: "gui-system-status/v1",
    ok: true,
    observedAt: "2026-11-08T00:00:00.000Z",
    daemon: {
      daemonId: "daemon-a",
      pid: 7,
      startedAt: "2026-11-08T00:00:00.000Z",
      protocolVersion: { major: 1, minor: 0 },
      uptimeMs: 1,
      endpoint: "/tmp/socket",
      build: { version: "0.1.0", commitSha: "c3a714be2e" },
      activeControl: null,
    },
    repos: [],
    futureOptionalField: true,
  };
  assert.throws(() => parseDaemonGuiReadResult("daemon.gui.system.read", systemStatus), /futureOptionalField/u);
  assert.equal(parseDaemonGuiReadResponse("daemon.gui.system.read", systemStatus).ok, true);
});
