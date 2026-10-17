// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import type { DaemonHost } from "../src/daemon-host.ts";
import { openDaemonConnLog, daemonConnLogFileStem } from "../src/conn-log.ts";
import { daemonRequestLogPath, openDaemonRequestLog } from "../src/request-log.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";

function tempRoot(t: TestContext): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harness-command-attribution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// The read branch only needs the exit validator's shape: attribution happens before the host read.
function stubHost(): DaemonHost {
  return { read: async () => ({ ok: true }) } as unknown as DaemonHost;
}

function connRecords(userRoot: string, daemonId: string): Record<string, unknown>[] {
  const dir = path.join(userRoot, "logs"),
    day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return readdirSync(dir)
    .filter((name) => name.startsWith(daemonConnLogFileStem(daemonId)) && name.includes(day))
    .sort()
    .flatMap((name) =>
      readFileSync(path.join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
}

// The positive control research 3 could not produce: a real CLI-shaped invocation of `ha agenda`
// (dedicated connection, hello carrying the parsed command id and the session actor) must land in
// BOTH sinks keyed by the CLI command name with the caller's identity — not by repo.agenda.read.
test("a CLI-shaped agenda invocation is attributed by command name and actor in both request sinks", async (t) => {
  const userRoot = tempRoot(t),
    daemonId = `attribution-${process.pid}`,
    connLog = openDaemonConnLog({ userRoot, daemonId }),
    requestLog = openDaemonRequestLog({ resolveRootDir: () => userRoot });
  const transport = createUnixSocketTransportServer({
    daemonId,
    createProtocolServer: (authContext, emit, connectionId, signal) => {
      const labelled = connLog.connectionOpened(connectionId, authContext.transportKind);
      return createJsonRpcProtocolServer({
        host: stubHost(),
        build: { commit: null },
        authContext: { ...authContext, connectionSignal: signal },
        emit,
        connectionId: labelled,
        recordRequest: requestLog.record,
        recordTraffic: connLog.request,
      });
    },
    onConnectionClosed: (connection) => connLog.connectionClosed(connection.connectionId),
  });
  await transport.start();
  const socketPath = transport.endpoint;
  try {
    const parsed = parseThinCommand(["agenda", "--json"], userRoot);
    assert.equal(parsed.ok, true, "ha agenda parses");
    if (!parsed.ok) return;
    // Exactly what runCommandThroughDaemon forwards: the route id and the session actor.
    const cliResult = await requestDaemonJsonRpcAt(
      socketPath,
      parsed.command.method,
      { repo: { repoId: "canonical" }, payload: {} },
      75,
      undefined,
      { HARNESS_ACTOR: "agent:runtime-session:runtime_positive_control" },
      false,
      parsed.command.id,
    );
    assert.equal((cliResult as { ok?: boolean }).ok, true);
    // The same method without a CLI declaration is the GUI shape: same command key, no actor.
    await requestDaemonJsonRpcAt(socketPath, "repo.agenda.read", { repo: { repoId: "canonical" }, payload: {} }, 75);
    await requestLog.settle();
    await connLog.settle();

    const requests = readFileSync(daemonRequestLogPath(userRoot), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.length, 2);
    const [cli, gui] = requests;
    assert.equal(cli?.method, "repo.agenda.read");
    assert.equal(cli?.command, "agenda");
    assert.equal(cli?.actor, "runtime-session:runtime_positive_control");
    assert.equal(cli?.ok, true);
    assert.equal(gui?.command, "agenda");
    assert.equal(gui?.actor, null, "a GUI-shaped connection declares no session actor");

    const traffic = connRecords(userRoot, daemonId).filter((record) => record.event === "request");
    const agendaLines = traffic.filter((record) => record.method === "repo.agenda.read");
    assert.equal(agendaLines.length, 2);
    for (const line of agendaLines) assert.equal(line.command, "agenda");
    assert.equal(agendaLines[0]?.actor, "runtime-session:runtime_positive_control");
    assert.equal(agendaLines[1]?.actor, null);
    const hello = traffic.find((record) => record.method === "protocol.hello");
    assert.equal(hello?.command, "agenda", "the declaring connection's hello names its command");
  } finally {
    await transport.stop();
  }
});
