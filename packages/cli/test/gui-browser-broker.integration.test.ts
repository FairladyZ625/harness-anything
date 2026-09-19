// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { startBrowserGuiBroker } from "../src/cli/gui-browser-broker.ts";
import {
  daemonId,
  environment,
  initialize,
  run,
  runMaybe,
  seedSettingsEvent,
  startDaemon,
} from "./release-cli-acceptance.fixture.ts";

test("browser GUI broker opens on exact loopback and rejects cross-origin RPC", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-browser-broker-"));
  mkdirSync(path.join(root, "packages/gui/dist"), { recursive: true });
  writeFileSync(path.join(root, "packages/gui/dist/index.html"), "<!doctype html><title>GUI</title>");
  const broker = await startBrowserGuiBroker(root, root);
  try {
    const url = new URL(broker.url),
      token = new URLSearchParams(url.hash.slice(1)).get("access_token");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(Buffer.from(token!, "base64url").length, 32);
    assert.equal((await call(url, "/")).headers["content-security-policy"]?.includes("default-src 'self'"), true);
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary Chromium reaches the task shell through authenticated browser RPC", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-browser-renderer-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    previousUserRoot = process.env.HARNESS_DAEMON_USER_ROOT,
    previousDaemonId = process.env.HARNESS_DAEMON_ID;
  let broker: Awaited<ReturnType<typeof startBrowserGuiBroker>> | undefined;
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
    broker = await startBrowserGuiBroker(path.resolve("."), root);
    const executablePath = chromiumExecutable(parent);
    const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage(),
        rpcStatuses: number[] = [];
      page.on("response", (response) => {
        if (new URL(response.url()).pathname === "/rpc") rpcStatuses.push(response.status());
      });
      await page.goto(broker.url);
      await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
      await page.getByTestId("browser-capability-notice").waitFor();
      await page.reload();
      await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
      await page.getByTestId("overview-status-planned").click();
      const taskRow = page.getByText("Browser E2E task", { exact: true });
      await taskRow.waitFor();
      await taskRow.click();
      await page.getByTestId("task-preview-backdrop").locator("footer button").first().click();
      await page.getByTestId("task-detail-view").waitFor();
      assert.ok(rpcStatuses.includes(200), `expected a 200 POST /rpc, saw ${rpcStatuses.join(",")}`);

      const unavailableResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/rpc" && response.status() === 502,
        { timeout: 30_000 },
      );
      run(root, userRoot, ["daemon", "stop"]);
      const unavailableBody = (await unavailableResponse).json();
      assert.equal((await unavailableBody).error.code, "daemon_unavailable");
      const recoveredResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/rpc" && response.status() === 200,
        { timeout: 30_000 },
      );
      startDaemon(root, userRoot);
      await recoveredResponse;
      await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
    } finally {
      await browser.close();
    }
    const rendererSources = rendererSourceFiles(path.resolve("packages/gui/src/renderer"));
    assert.deepEqual(rendererSources, [path.resolve("packages/gui/src/renderer/gui-transport.ts")]);
  } finally {
    if (broker) await broker.close();
    runMaybe(root, userRoot, ["daemon", "stop"]);
    if (previousUserRoot === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = previousUserRoot;
    if (previousDaemonId === undefined) delete process.env.HARNESS_DAEMON_ID;
    else process.env.HARNESS_DAEMON_ID = previousDaemonId;
    rmSync(parent, { recursive: true, force: true });
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
    const firstStore = seedSettingsEvent({ rootDir: firstRoot, repoId: "browser-write-first" }),
      secondStore = seedSettingsEvent({ rootDir: secondRoot, repoId: "browser-write-second" });
    assert.ok(firstStore && secondStore);
    const initialRevision = firstStore.read().revision;
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
    broker = await startBrowserGuiBroker(path.resolve("."), firstRoot);
    const url = new URL(broker.url),
      token = new URLSearchParams(url.hash.slice(1)).get("access_token")!;
    const sameWrite = settingsWrite("browser-write-first", "same-key", undefined, 1024),
      [first, replay] = await Promise.all([browserRpc(url, token, sameWrite), browserRpc(url, token, sameWrite)]);
    assert.equal(first.status, 200, first.body);
    assert.equal(replay.status, 200, replay.body);
    const firstReceipt = JSON.parse(first.body) as { readonly opId: string; readonly outcome: string },
      replayReceipt = JSON.parse(replay.body) as { readonly opId: string; readonly outcome: string };
    assert.equal(firstReceipt.outcome, "applied", JSON.stringify({ firstReceipt, replayReceipt }));
    assert.equal(replayReceipt.opId, firstReceipt.opId);
    await settleBrowserWrite(url, token, "browser-write-first", firstReceipt.opId);

    const stale = await browserRpc(
      url,
      token,
      settingsWrite("browser-write-first", "stale-key", initialRevision, 2048),
    );
    assert.equal(stale.status, 200, stale.body);
    assert.equal((JSON.parse(stale.body) as { readonly code: string }).code, "revision_conflict");

    const second = await browserRpc(url, token, settingsWrite("browser-write-second", "same-key", undefined, 4096));
    assert.equal(second.status, 200, second.body);
    const secondReceipt = JSON.parse(second.body) as { readonly opId: string; readonly outcome: string };
    assert.equal(secondReceipt.outcome, "applied");
    assert.notEqual(secondReceipt.opId, firstReceipt.opId);
    await settleBrowserWrite(url, token, "browser-write-second", secondReceipt.opId);
    assert.match(readFileSync(path.join(firstRoot, "harness/harness.yaml"), "utf8"), /events: 1024/u);
    assert.match(readFileSync(path.join(secondRoot, "harness/harness.yaml"), "utf8"), /events: 4096/u);
  } finally {
    if (broker) await broker.close();
    runMaybe(firstRoot, userRoot, ["daemon", "stop"]);
    if (previousUserRoot === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = previousUserRoot;
    if (previousDaemonId === undefined) delete process.env.HARNESS_DAEMON_ID;
    else process.env.HARNESS_DAEMON_ID = previousDaemonId;
    rmSync(parent, { recursive: true, force: true });
  }
});

function settingsWrite(
  repoId: string,
  idempotencyKey: string,
  expectedVersion: number | undefined,
  walFlushEvents: number,
) {
  return JSON.stringify({
    method: "repo.settings.update",
    params: {
      repo: { repoId },
      payload: { idempotencyKey, ...(expectedVersion === undefined ? {} : { expectedVersion }), walFlushEvents },
    },
  });
}

function initializeSettingsRepo(root: string): void {
  initialize(root);
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "layout:\n  authoredRoot: harness\nsettings:\n  walFlush:\n    events: 256\n",
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
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    candidates = [configured, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  const executable = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (executable) return executable;
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(parent, "playwright-browsers");
  execFileSync(process.execPath, [path.resolve("node_modules/playwright-core/cli.js"), "install", "chromium"], {
    stdio: "pipe",
  });
  const downloaded = findFile(process.env.PLAYWRIGHT_BROWSERS_PATH, "chrome");
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
