// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { startBrowserGuiBroker } from "../src/cli/gui-browser-broker.ts";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import { fixtureDaemonHello } from "../../daemon/test/fixtures/daemon-hello.ts";
import { makeAgentRuntimeStreamHub } from "../../daemon/test/fixtures/runtime-stream.ts";
import type { RuntimeSession } from "@harness-anything/kernel";
import { startBrowserGuiFixture } from "./gui-browser-broker.fixture.ts";
import {
  daemonId,
  environment,
  initialize,
  run,
  runMaybe,
  seedSettingsEvent,
  startDaemon,
} from "./release-cli-acceptance.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

// dec_89D06D7360CBEC09795F7B12EC/CH3: a real browser reads the socket hub through the authenticated
// loopback broker, and aborting the fetch tears down the underlying subscriber.
test("headless Chromium receives the hub snapshot and releases its socket on abort", { timeout: 120_000 }, async () => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-browser-sse-"))),
    userRoot = path.join(parent, "user"),
    repoId = "browser-stream",
    method = "repo.agentRuntime.attach",
    sessionId = "runtime-browser",
    socketPath = localUserDaemonEndpoint(userRoot, daemonId),
    hub = makeAgentRuntimeStreamHub({
      repoId,
      readSession: () => ({ runtimeSessionId: sessionId }) as RuntimeSession,
      canAttach: () => true,
    }),
    released = Promise.withResolvers<void>();
  let attachRequests = 0;
  const server = createSocketServer((socket) => {
    const controller = new AbortController();
    const lines = createInterface({ input: socket });
    socket.once("close", () => {
      controller.abort();
      lines.close();
      released.resolve();
    });
    lines.on("line", (line) => {
      const packet = JSON.parse(line);
      if (packet.method === "protocol.hello") {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: packet.id, result: fixtureDaemonHello() })}\n`);
        return;
      }
      assert.equal(packet.method, method);
      assert.equal(packet.params.repo.repoId, repoId);
      const attempt = ++attachRequests;
      void hub.attach(sessionId, packet.params.payload.afterCursor, controller.signal).then((subscription) => {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: packet.id, result: subscription.initial })}\n`);
        if (attempt > 1) {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: `${method}.frame.end`,
              params: { code: "invalid_result" },
            })}\n`,
          );
          return;
        }
        const next = hub.publish(sessionId, { type: "heartbeat" });
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: `${method}.frame`, params: next })}\n`);
      });
    });
  });
  const previousUserRoot = process.env.HARNESS_DAEMON_USER_ROOT,
    previousDaemonId = process.env.HARNESS_DAEMON_ID;
  let broker: Awaited<ReturnType<typeof startBrowserGuiBroker>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    mkdirSync(userRoot);
    mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(userRoot, "registry.json"),
      JSON.stringify({
        schema: "harness-daemon-registry/v2",
        connections: [{ id: "local", kind: "local", displayName: "This device", state: "enabled" }],
        repos: [
          {
            repoId,
            canonicalRoot: parent,
            displayName: "Browser Stream",
            authoredBranch: "main",
            mode: "local",
            connectionId: "local",
            state: "enabled",
            registeredAt: "2026-11-19T00:00:00.000Z",
          },
        ],
      }),
    );
    process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
    process.env.HARNESS_DAEMON_ID = daemonId;
    server.listen(socketPath);
    await once(server, "listening");
    const first = hub.publish(sessionId, { type: "activity", activity: "message", content: "snapshot activity" });
    for (let seq = 0; seq < 32; seq++) hub.publish(sessionId, { type: "heartbeat" });
    broker = await startBrowserGuiFixture(parent, parent, "<!doctype html><title>Stream</title>");
    browser = await chromium.launch({
      executablePath: chromiumExecutable(parent),
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    const url = new URL(broker.url),
      token = new URLSearchParams(url.hash.slice(1)).get("access_token")!;
    const body = JSON.stringify({
      method,
      params: { repo: { repoId }, payload: { runtimeSessionId: sessionId, afterCursor: first.cursor } },
    });
    assert.equal(
      (await call(url, "/stream", { method: "POST", body, token, origin: "https://example.test" })).status,
      403,
    );
    assert.equal((await call(url, "/stream", { method: "POST", body, origin: url.origin })).status, 403);
    assert.equal(
      (
        await call(url, "/stream", {
          method: "POST",
          body: body.replace(method, "repo.task.run"),
          token,
          origin: url.origin,
        })
      ).status,
      400,
    );
    await page.goto(url.origin);
    const frames = await page.evaluate(
      async ({ body, token }) => {
        const controller = new AbortController();
        const response = await fetch("/stream", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (response.status !== 200 || response.headers.get("content-type") !== "text/event-stream")
          throw new Error(`Unexpected stream response: ${response.status}`);
        try {
          const reader = response.body!.getReader(),
            decoder = new TextDecoder();
          let pending = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("Socket ended before the snapshot and its first increment.");
            pending += decoder.decode(chunk.value, { stream: true });
            const completed = pending.split("\n\n").slice(0, -1);
            if (completed.length >= 2) return completed.map((frame) => JSON.parse(frame.slice(6)));
          }
        } finally {
          controller.abort();
        }
      },
      { body, token },
    );
    assert.equal(frames[0].status, "gap");
    assert.equal(frames[0].events[0].snapshot.activity.content, "snapshot activity");
    assert.equal(frames[0].events[0].snapshotSeq, 33);
    assert.equal(frames[1].cursor.seq, 34);
    await released.promise;
    const ended = await page.evaluate(
      async ({ token, body }) => {
        const response = await fetch("/stream", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
        });
        return { status: response.status, text: await response.text() };
      },
      { token, body },
    );
    assert.equal(ended.status, 200);
    assert.equal(ended.text.split("\n\n").filter(Boolean).at(-1), 'event: end\ndata: {"code":"invalid_result"}');
  } finally {
    await browser?.close();
    await broker?.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    hub.close();
    if (previousUserRoot === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = previousUserRoot;
    if (previousDaemonId === undefined) delete process.env.HARNESS_DAEMON_ID;
    else process.env.HARNESS_DAEMON_ID = previousDaemonId;
    removeTempRepository(parent);
  }
});

test("browser GUI broker opens on exact loopback and rejects cross-origin RPC", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-browser-broker-")),
    guiPackageRoot = path.join(root, "packages/gui");
  const broker = await startBrowserGuiFixture(guiPackageRoot, root, "<!doctype html><title>GUI</title>");
  try {
    const url = new URL(broker.url),
      token = new URLSearchParams(url.hash.slice(1)).get("access_token");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(Buffer.from(token!, "base64url").length, 32);
    const index = await call(url, "/");
    assert.equal(index.headers["content-security-policy"]?.includes("default-src 'self'"), true);
    assert.equal(index.status, 200, "GET / must serve the fixture index.html, not a 404 that still carries headers");
    assert.equal(index.body, "<!doctype html><title>GUI</title>");
    assert.equal((await call(url, "/rpc", { method: "POST" })).status, 403);
    const writeBody = JSON.stringify({
      method: "repo.settings.update",
      params: {
        repo: { repoId: "canonical" },
        payload: { locale: "zh-CN", idempotencyKey: "browser-security-write" },
      },
    });
    assert.equal((await call(url, "/rpc", { method: "POST", body: writeBody })).status, 403);
    assert.equal((await call(url, "/rpc", { method: "POST", body: writeBody, cookie: "access_token=x" })).status, 403);
    assert.equal(
      (await call(url, "/rpc", { method: "POST", body: writeBody, token: "wrong", origin: url.origin })).status,
      403,
    );
    assert.equal(
      (await call(url, "/rpc", { method: "POST", token: token!, origin: "http://example.test" })).status,
      403,
    );
    assert.equal(
      (await call(url, "/rpc", { method: "POST", body: writeBody, token: token!, origin: "null" })).status,
      403,
    );
    assert.equal(
      (await call(url, "/rpc", { method: "POST", token: token!, host: `localhost:${url.port}` })).status,
      403,
    );
    assert.equal((await call(url, "/rpc", { method: "OPTIONS", token: token!, origin: url.origin })).status, 405);
    assert.equal(
      (await call(url, "/rpc", { method: "POST", token: token!, origin: url.origin, body: "{" })).status,
      400,
    );
    assert.equal(
      (
        await call(url, "/rpc", {
          method: "POST",
          token: token!,
          origin: url.origin,
          body: JSON.stringify({ method: "repo.tasks.list", params: { padding: "x".repeat(1024 * 1024) } }),
        })
      ).status,
      400,
    );
    const admitted = await call(url, "/rpc", { method: "POST", token: token!, origin: url.origin });
    assert.equal(admitted.status, 502, "valid auth reaches the isolated missing-daemon boundary");
    const admittedWrite = await call(url, "/rpc", {
      method: "POST",
      token: token!,
      origin: url.origin,
      body: writeBody,
    });
    assert.equal(admittedWrite.status, 502, "authenticated canonical write reaches the daemon boundary");
    assert.equal(admittedWrite.headers["access-control-allow-origin"], undefined);
  } finally {
    await broker.close();
    removeTempRepository(root);
  }
});

test("browser GUI embedding requires an explicit matching parent without changing RPC authentication", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-browser-parent-"));
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist/index.html"), "<!doctype html><title>Embedded GUI</title><p>Embedded GUI</p>");
  const parent = createServer((_request, response) => response.end("<!doctype html><title>Parent</title>"));
  await new Promise<void>((resolve) => parent.listen(0, "127.0.0.1", resolve));
  const address = parent.address();
  assert.ok(address && typeof address !== "string");
  const parentOrigin = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      executablePath: chromiumExecutable(root),
      headless: true,
      args: ["--no-sandbox"],
    });
    for (const allowedParent of [undefined, "https://different.example", parentOrigin, "dsh-app://app"]) {
      const broker = await startBrowserGuiBroker(root, root, allowedParent);
      const page = await browser.newPage();
      try {
        const url = new URL(broker.url);
        const token = new URLSearchParams(url.hash.slice(1)).get("access_token")!;
        const index = await call(url, "/");
        assert.equal(
          index.headers["content-security-policy"],
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            `img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${allowedParent ?? "'none'"}`,
        );
        await page.goto(parentOrigin);
        const errors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const blocked =
          allowedParent !== parentOrigin
            ? page.waitForEvent("console", { predicate: (message) => message.text().includes("frame-ancestors") })
            : undefined;
        await page.evaluate((src) => {
          const frame = document.createElement("iframe");
          frame.src = src;
          document.body.append(frame);
        }, broker.url);
        if (blocked) {
          await blocked;
          assert.equal(await page.frameLocator("iframe").getByText("Embedded GUI").count(), 0);
        } else {
          await page.frameLocator("iframe").getByText("Embedded GUI").waitFor();
          assert.equal(errors.filter((error) => error.includes("frame-ancestors")).length, 0);
        }
        for (const auth of [undefined, "wrong"]) {
          assert.equal((await call(url, "/rpc", { method: "POST", origin: url.origin, token: auth })).status, 403);
        }
        for (const origin of [parentOrigin, "null", "https://different.example"]) {
          assert.equal((await call(url, "/rpc", { method: "POST", origin, token })).status, 403);
        }
        assert.equal(
          (await call(url, "/rpc", { method: "POST", origin: url.origin, token })).status,
          502,
          "valid bearer still reaches the isolated missing-daemon boundary",
        );
      } finally {
        await page.close();
        await broker.close();
      }
    }
    for (const invalid of ["*", "http://127.0.0.1:*", "https://example; frame-ancestors *", "null"]) {
      await assert.rejects(startBrowserGuiBroker(root, root, invalid), /parent origin/i);
    }
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => parent.close((error) => (error ? reject(error) : resolve())));
    removeTempRepository(root);
  }
});

test("ordinary Chromium embeds real task data through authenticated browser RPC", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-browser-renderer-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    previousUserRoot = process.env.HARNESS_DAEMON_USER_ROOT,
    previousDaemonId = process.env.HARNESS_DAEMON_ID;
  let broker: Awaited<ReturnType<typeof startBrowserGuiBroker>> | undefined;
  const parentServer = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><title>Parent</title><body style="margin:0"><iframe style="display:block;width:100vw;height:100vh;border:0" src="${broker?.url ?? "about:blank"}"></iframe>`,
    );
  });
  await new Promise<void>((resolve) => parentServer.listen(0, "127.0.0.1", resolve));
  const address = parentServer.address();
  assert.ok(address && typeof address !== "string");
  const parentOrigin = `http://127.0.0.1:${address.port}`;
  try {
    initialize(root);
    seedSettingsEvent({ rootDir: root, repoId: "browser-e2e" });
    startDaemon(root, userRoot);
    run(root, userRoot, ["daemon", "repo", "register", "--repo-id", "browser-e2e", "--root", root, "--no-link"]);
    run(root, userRoot, ["task", "create", "--id", "task-browser-e2e", "--admin", "--title", "Browser E2E task"]);
    execFileSync("npm", ["run", "build", "--workspace", "@harness-anything/gui"], {
      cwd: path.resolve("."),
      env: environment(root, userRoot),
      stdio: "pipe",
    });
    process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
    process.env.HARNESS_DAEMON_ID = daemonId;
    broker = await startBrowserGuiBroker(path.resolve("packages/gui"), root, parentOrigin);
    const executablePath = chromiumExecutable(parent);
    const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage(),
        rpcStatuses: number[] = [];
      page.on("response", (response) => {
        if (new URL(response.url()).pathname === "/rpc") rpcStatuses.push(response.status());
      });
      const cspErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" && /content security policy|frame-ancestors/iu.test(message.text()))
          cspErrors.push(message.text());
      });
      await page.goto(parentOrigin);
      const gui = page.frameLocator("iframe");
      await gui.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
      await gui.getByTestId("browser-capability-notice").waitFor();
      await page.reload();
      await gui.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
      await gui
        .getByTestId("app-sidebar")
        .getByRole("button", { name: /^(?:看板|Board)$/u })
        .click();
      const taskRow = gui.getByTestId("board-task-card").filter({ hasText: "Browser E2E task" });
      await taskRow.waitFor();
      await taskRow.click();
      await gui.getByRole("dialog").locator("footer button").first().click();
      await gui.getByTestId("task-detail-view").waitFor();
      assert.ok(rpcStatuses.includes(200), `expected a 200 POST /rpc, saw ${rpcStatuses.join(",")}`);

      assert.deepEqual(cspErrors, []);

      // This process also serves the broker: a synchronous stop blocks its
      // in-flight RPC sockets from draining while the CLI waits for daemon exit.
      const [unavailableResponse] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === "/rpc" && response.status() === 502, {
          timeout: 30_000,
        }),
        promisify(execFile)(
          process.execPath,
          [path.resolve("packages/cli/src/index.ts"), "--root", root, "--json", "daemon", "stop"],
          { env: environment(root, userRoot) },
        ),
      ]);
      const unavailableBody = unavailableResponse.json();
      assert.equal((await unavailableBody).error.code, "daemon_unavailable");
      startDaemon(root, userRoot);
      const recoveredResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/rpc" && response.status() === 200,
        { timeout: 30_000 },
      );
      await recoveredResponse;
      await gui.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
    } finally {
      await browser.close();
    }
    const rendererSources = rendererSourceFiles(path.resolve("packages/gui/src/renderer"));
    assert.deepEqual(rendererSources, [path.resolve("packages/gui/src/renderer/gui-transport.ts")]);
  } finally {
    if (broker) await broker.close();
    await new Promise<void>((resolve, reject) => parentServer.close((error) => (error ? reject(error) : resolve())));
    runMaybe(root, userRoot, ["daemon", "stop"]);
    if (previousUserRoot === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = previousUserRoot;
    if (previousDaemonId === undefined) delete process.env.HARNESS_DAEMON_ID;
    else process.env.HARNESS_DAEMON_ID = previousDaemonId;
    removeTempRepository(parent);
  }
});

test("browser writes preserve RepoCell idempotency, revision fences, and repository scope", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-browser-writes-")),
    firstRoot = path.join(parent, "first"),
    secondRoot = path.join(parent, "second"),
    userRoot = path.join(parent, "user"),
    previousUserRoot = process.env.HARNESS_DAEMON_USER_ROOT,
    previousDaemonId = process.env.HARNESS_DAEMON_ID;
  let broker: Awaited<ReturnType<typeof startBrowserGuiBroker>> | undefined;
  try {
    initializeSettingsRepo(firstRoot);
    initializeSettingsRepo(secondRoot);
    const firstStore = seedSettingsEvent({ rootDir: firstRoot, repoId: "browser-write-first", keepOpen: true }),
      secondStore = seedSettingsEvent({ rootDir: secondRoot, repoId: "browser-write-second", keepOpen: true });
    assert.ok(firstStore && secondStore);
    const initialRevision = firstStore.read().revision;
    void firstStore.drain();
    void secondStore.drain();
    startDaemon(firstRoot, userRoot);
    run(firstRoot, userRoot, [
      "daemon",
      "repo",
      "register",
      "--repo-id",
      "browser-write-first",
      "--root",
      firstRoot,
      "--no-link",
    ]);
    run(secondRoot, userRoot, [
      "daemon",
      "repo",
      "register",
      "--repo-id",
      "browser-write-second",
      "--root",
      secondRoot,
      "--no-link",
    ]);
    process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
    process.env.HARNESS_DAEMON_ID = daemonId;
    broker = await startBrowserGuiBroker(path.resolve("packages/gui"), firstRoot);
    const url = new URL(broker.url),
      token = new URLSearchParams(url.hash.slice(1)).get("access_token")!;
    const sameWrite = settingsWrite("browser-write-first", "same-key", undefined, 4),
      [first, replay] = await Promise.all([browserRpc(url, token, sameWrite), browserRpc(url, token, sameWrite)]);
    assert.equal(first.status, 200, first.body);
    assert.equal(replay.status, 200, replay.body);
    const firstReceipt = JSON.parse(first.body) as { readonly opId: string; readonly outcome: string },
      replayReceipt = JSON.parse(replay.body) as { readonly opId: string; readonly outcome: string };
    assert.equal(firstReceipt.outcome, "applied", JSON.stringify({ firstReceipt, replayReceipt }));
    assert.equal(replayReceipt.opId, firstReceipt.opId);
    await settleBrowserWrite(url, token, "browser-write-first", firstReceipt.opId);

    const stale = await browserRpc(url, token, settingsWrite("browser-write-first", "stale-key", initialRevision, 5));
    assert.equal(stale.status, 200, stale.body);
    assert.equal((JSON.parse(stale.body) as { readonly code: string }).code, "revision_conflict");

    const second = await browserRpc(url, token, settingsWrite("browser-write-second", "same-key", undefined, 6));
    assert.equal(second.status, 200, second.body);
    const secondReceipt = JSON.parse(second.body) as { readonly opId: string; readonly outcome: string };
    assert.equal(secondReceipt.outcome, "applied");
    assert.notEqual(secondReceipt.opId, firstReceipt.opId);
    await settleBrowserWrite(url, token, "browser-write-second", secondReceipt.opId);
    assert.match(readFileSync(path.join(firstRoot, "harness/harness.yaml"), "utf8"), /reviewReturnBudget: 4/u);
    assert.match(readFileSync(path.join(secondRoot, "harness/harness.yaml"), "utf8"), /reviewReturnBudget: 6/u);
  } finally {
    if (broker) await broker.close();
    runMaybe(firstRoot, userRoot, ["daemon", "stop"]);
    if (previousUserRoot === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = previousUserRoot;
    if (previousDaemonId === undefined) delete process.env.HARNESS_DAEMON_ID;
    else process.env.HARNESS_DAEMON_ID = previousDaemonId;
    removeTempRepository(parent);
  }
});

function settingsWrite(
  repoId: string,
  idempotencyKey: string,
  expectedVersion: number | undefined,
  reviewReturnBudget: number,
) {
  return JSON.stringify({
    method: "repo.settings.update",
    params: {
      repo: { repoId },
      payload: { idempotencyKey, ...(expectedVersion === undefined ? {} : { expectedVersion }), reviewReturnBudget },
    },
  });
}

function initializeSettingsRepo(root: string): void {
  initialize(root);
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\nsettings:\n  reviewReturnBudget: 3\n",
  );
  execFileSync("git", ["-C", root, "add", "harness/harness.yaml"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "settings fixture"]);
}

function browserRpc(url: URL, token: string, body: string) {
  return call(url, "/rpc", { method: "POST", token, origin: url.origin, body });
}

async function settleBrowserWrite(url: URL, token: string, repoId: string, opId: string): Promise<void> {
  const settled = await browserRpc(
    url,
    token,
    JSON.stringify({
      method: "repo.receipt.show",
      params: { repo: { repoId }, payload: { opId, waitFor: ["worktree_visible"], timeoutMs: 20_000 } },
    }),
  );
  assert.equal(settled.status, 200, settled.body);
  assert.equal((JSON.parse(settled.body) as { readonly wait?: { readonly state?: string } }).wait?.state, "satisfied");
}

function chromiumExecutable(parent: string): string {
  const browserName =
    process.platform === "darwin"
      ? "Google Chrome for Testing"
      : process.platform === "win32"
        ? "chrome.exe"
        : "chrome";
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    candidates = [configured, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  const executable = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (executable) return executable;
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const cached = findFile(process.env.PLAYWRIGHT_BROWSERS_PATH, browserName);
    assert.ok(cached, "isolated dependency preparation did not cache Playwright Chromium");
    return cached;
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(parent, "playwright-browsers");
  execFileSync(process.execPath, [path.resolve("node_modules/playwright-core/cli.js"), "install", "chromium"], {
    stdio: "pipe",
  });
  const downloaded = findFile(process.env.PLAYWRIGHT_BROWSERS_PATH, browserName);
  assert.ok(downloaded, "Playwright installed Chromium without its browser executable");
  return downloaded;
}

function findFile(directory: string, name: string): string | null {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(target, name);
      if (nested) return nested;
    } else if (entry.name === name) return target;
  }
  return null;
}

function rendererSourceFiles(root: string): string[] {
  const matches: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.tsx?$/u.test(entry.name) && /window\.harness/u.test(readFileSync(target, "utf8")))
        matches.push(target);
    }
  };
  visit(root);
  return matches.sort();
}

function call(
  url: URL,
  pathname: string,
  options: { method?: string; token?: string; origin?: string; host?: string; body?: string; cookie?: string } = {},
) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const body = JSON.stringify({ method: "repo.tasks.list", params: { repo: { repoId: "canonical" } } });
      const outgoing = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: pathname,
          method: options.method ?? "GET",
          headers: {
            Host: options.host ?? url.host,
            ...(options.origin ? { Origin: options.origin } : {}),
            ...(options.token ? { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" } : {}),
            ...(options.cookie ? { Cookie: options.cookie } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      outgoing.on("error", reject);
      if (options.method === "POST") outgoing.write(options.body ?? body);
      outgoing.end();
    },
  );
}
