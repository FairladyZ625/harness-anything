// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { promisify } from "node:util";
import { canonicalRoot, workspaceId } from "@harness-anything/daemon/internal/protocol/daemon-protocol-identifiers";
import { createJsonRpcProtocolServer, localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import { makeTaskEventReader } from "@harness-anything/storage";
import { createLocalGuiServiceBridge } from "../../gui/src/main/local-composition-root.ts";
import { withPolicyGroup } from "../../daemon/test/keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell, registerBootstrappedDaemonRepo } from "../../daemon/test/repo-settings.fixture.ts";
import { initRepo } from "../../daemon/test/task-surface.fixtures.ts";
import { startBrowserGuiBroker } from "../src/cli/gui-browser-broker.ts";

// dec_89D06D7360CBEC09795F7B12EC/CH3: lose an applied receipt at the socket, after the
// real writer accepted it. Every entry point retransmits the same request to that writer.
test("CLI, Electron composition, and Browser broker replay one committed write after a lost receipt", async (t) => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-unary-retry-"))),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = "local-retry",
    repoId = workspaceId("local-retry"),
    socketPath = localUserDaemonEndpoint(userRoot, daemonId);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(rootDir);
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  initRepo(rootDir);
  registerBootstrappedDaemonRepo({
    userRoot,
    repoId,
    canonicalRoot: rootDir,
    displayName: "Local retry",
    mode: "local",
  });
  const cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "local-retry" });
  const binding = withPolicyGroup(
    {
      actor: { principal: { personId: "local-retry-owner" }, executor: null },
      source: "local",
    },
    "admin",
  );
  const requests = new Map<string, unknown[]>();
  const server = createServer((socket) => {
    const rpc = createJsonRpcProtocolServer({
      host: {
        run: async (_repo: string, action: Parameters<typeof cell.run>[0]) => cell.run(action, binding),
      } as never,
      build: { loadedBuildId: null, commit: null, builtAt: null },
      authContext: { transportKind: "unix-socket" },
      emit: async () => undefined,
    });
    const lines = createInterface({ input: socket });
    socket.once("close", () => rpc.close());
    lines.on("line", (line) => {
      const request = JSON.parse(line);
      void rpc.handle(request).then(
        (response) => {
          if (request.method === "repo.task.create") {
            const key = request.params.payload.idempotencyKey,
              previous = requests.get(key) ?? [];
            requests.set(key, [...previous, request.params]);
            if (
              previous.length === 0 &&
              response &&
              "result" in response &&
              (response.result as { ok?: boolean }).ok === true
            ) {
              socket.destroy();
              return;
            }
          }
          socket.write(`${JSON.stringify(response)}\n`);
        },
        (error: Error) => socket.destroy(error),
      );
    });
    socket.on("error", () => socket.destroy());
  });
  const originalUserRoot = process.env.HARNESS_DAEMON_USER_ROOT,
    originalDaemonId = process.env.HARNESS_DAEMON_ID;
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  process.env.HARNESS_DAEMON_ID = daemonId;
  let broker: Awaited<ReturnType<typeof startBrowserGuiBroker>> | undefined;
  try {
    server.listen(socketPath);
    await once(server, "listening");
    mkdirSync(path.join(parent, "dist"));
    writeFileSync(path.join(parent, "dist/index.html"), "<!doctype html><title>Local retry</title>");
    broker = await startBrowserGuiBroker(parent, rootDir);
    const url = new URL(broker.url),
      token = new URLSearchParams(url.hash.slice(1)).get("access_token"),
      exec = promisify(execFile),
      electron = createLocalGuiServiceBridge();
    const cli = await exec(process.execPath, [
      path.resolve("packages/cli/src/index.ts"),
      "--root",
      rootDir,
      "--json",
      "task",
      "create",
      "--title",
      "CLI retry",
      "--idempotency-key",
      "cli-retry",
    ]);
    assert.equal(JSON.parse(cli.stdout).ok, true, cli.stdout);
    const electronReply = await electron.invoke("repo.task.create", {
      repo: { repoId },
      payload: { title: "Electron retry", idempotencyKey: "electron-retry" },
    });
    assert.equal(electronReply.ok, true, JSON.stringify(electronReply));
    const response = await fetch(new URL("/rpc", url), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: url.origin },
      body: JSON.stringify({
        method: "repo.task.create",
        params: { repo: { repoId }, payload: { title: "Browser retry", idempotencyKey: "browser-retry" } },
      }),
    });
    assert.equal(response.status, 200);
    const browserReply = await response.json();
    assert.equal(browserReply.ok, true, JSON.stringify(browserReply));
    assert.deepEqual([...requests.keys()], ["cli-retry", "electron-retry", "browser-retry"]);
    for (const packets of requests.values()) {
      assert.equal(packets.length, 2);
      assert.deepEqual(packets[0], packets[1]);
    }
    assert.equal(
      makeTaskEventReader({ rootDir, repoId })
        .read()
        .events.filter((event) => event.type === "task_created").length,
      3,
    );
  } finally {
    await broker?.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cell.close();
    if (originalUserRoot === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = originalUserRoot;
    if (originalDaemonId === undefined) delete process.env.HARNESS_DAEMON_ID;
    else process.env.HARNESS_DAEMON_ID = originalDaemonId;
  }
});
