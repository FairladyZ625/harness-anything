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
    assert.equal(
      (await call(url, "/rpc", { method: "POST", token: token!, origin: "http://example.test" })).status,
      403,
    );
    assert.equal(
      (await call(url, "/rpc", { method: "POST", token: token!, host: `localhost:${url.port}` })).status,
      403,
    );
    const admitted = await call(url, "/rpc", { method: "POST", token: token!, origin: url.origin });
    assert.equal(admitted.status, 502, "valid auth reaches the isolated missing-daemon boundary");
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
      const taskRow = page.getByText("Browser E2E task", { exact: true });
      await taskRow.waitFor();
      await taskRow.click();
      await page.getByTestId("task-preview-backdrop").locator("footer button").first().click();
      await page.getByTestId("task-detail-view").waitFor();
      assert.ok(rpcStatuses.includes(200), `expected a 200 POST /rpc, saw ${rpcStatuses.join(",")}`);
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
  options: { method?: string; token?: string; origin?: string; host?: string } = {},
) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
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
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers }));
      },
    );
    outgoing.on("error", reject);
    if (options.method === "POST") outgoing.write(body);
    outgoing.end();
  });
}
