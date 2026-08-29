#!/usr/bin/env node
// Human-facing GUI launcher: builds the preload bundle, starts the Vite dev
// renderer on the origin the security contract pins (http://127.0.0.1:5173),
// then launches the Electron shell against it. Ctrl+C or closing the window
// tears everything down. Zero dependencies beyond what the package already has.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const guiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(guiRoot, "../..");
const rendererUrl = "http://127.0.0.1:5173";

// Auto fast-forward the local checkout to origin/main before building, so the
// launcher always ships the latest merged GUI. Main is never developed on
// directly — all work lands through worktree PRs — so a clean fast-forward is
// always safe. Skip loudly (never fail the launch) when the checkout is not on
// main or the working tree is dirty; the daemon reads its canonical ledger from
// ~/.harness, not this source tree, so a source fast-forward does not disturb it.
function fastForwardToOriginMain() {
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout?.trim();
  if (branch !== "main") {
    log(`on '${branch}', not main — skipping auto fast-forward`);
    return;
  }
  if (spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout?.trim()) {
    log("working tree dirty — skipping auto fast-forward");
    return;
  }
  log("fetching origin/main...");
  if (spawnSync("git", ["fetch", "origin", "main"], { cwd: repoRoot, stdio: "inherit" }).status !== 0) {
    log("git fetch failed — building current checkout");
    return;
  }
  const ff = spawnSync("git", ["merge", "--ff-only", "origin/main"], { cwd: repoRoot, encoding: "utf8" });
  if (ff.status === 0) log("fast-forwarded to origin/main");
  else log(`not fast-forwardable (local diverged?) — building current checkout: ${(ff.stderr || "").trim()}`);
}
fastForwardToOriginMain();

const electronPath = require("electron");
// Resolve vite's own bin script through Node's module resolution rather than shelling
// out to npx: npx.cmd resolves its own npm-cli.js relative to the invoking npm script's
// cwd, which does not exist in this repo's hoisted workspace install and aborts on
// Windows (#1536). Running the bin file directly under the current Node needs no shell
// on any platform.
const viteBin = path.join(path.dirname(require.resolve("vite/package.json")), require("vite/package.json").bin.vite);

function log(message) {
  console.log(`[dev-electron] ${message}`);
}

log("building preload bundle...");
const preloadBuild = spawnSync(process.execPath, [viteBin, "build", "--config", "vite.preload.config.ts"], {
  cwd: guiRoot,
  stdio: "inherit",
});
if (preloadBuild.status !== 0) {
  console.error("[dev-electron] preload build failed");
  process.exit(preloadBuild.status ?? 1);
}

log(`starting renderer dev server at ${rendererUrl} ...`);
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
  cwd: guiRoot,
  env: { ...process.env, BROWSER: "none" },
  stdio: ["ignore", "pipe", "pipe"],
});
// Forwarding stdout (previously discarded) surfaces Vite's own diagnostics, including its
// "ready in" banner, in the launcher log instead of the poll loop being the only witness.
vite.stderr.on("data", (chunk) => process.stderr.write(chunk));
vite.stdout.on("data", (chunk) => process.stdout.write(chunk));

async function waitForRenderer() {
  // #1537: a cold start (config load, plugin init, dependency scan) measurably ran past
  // 30s under concurrent CPU load. Keep polling as long as the process is alive; the cap
  // only guards against a renderer that neither serves nor exits.
  const deadline = Date.now() + 180_000;
  let lastError;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) {
      throw new Error(`renderer dev server exited early with code ${vite.exitCode} (is port 5173 busy?)`);
    }
    try {
      const response = await fetch(rendererUrl);
      if (response.ok) return;
      lastError = new Error(`renderer returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  throw new Error(`renderer dev server not ready at ${rendererUrl}: ${lastError?.message ?? "timeout"}`);
}

async function stopVite() {
  if (vite.exitCode !== null || vite.signalCode !== null) return;
  vite.kill("SIGTERM");
  const closed = once(vite, "close");
  const timedOut = new Promise((resolveSleep) => setTimeout(() => resolveSleep("timeout"), 5_000));
  if ((await Promise.race([closed, timedOut])) === "timeout") {
    vite.kill("SIGKILL");
    await once(vite, "close").catch(() => undefined);
  }
}

try {
  await waitForRenderer();
} catch (error) {
  console.error(`[dev-electron] ${error.message}`);
  await stopVite();
  process.exit(1);
}

log("launching Electron shell...");
const electron = spawn(electronPath, [path.join(guiRoot, "src/main/electron-main.ts")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ELECTRON_RENDERER_URL: rendererUrl,
    HARNESS_GUI_ROOT: process.env.HARNESS_GUI_ROOT ?? repoRoot,
  },
  stdio: "inherit",
});

const shutdown = async (code) => {
  await stopVite();
  process.exit(code);
};
electron.on("close", (code) => void shutdown(code ?? 0));
process.on("SIGINT", () => {
  electron.kill("SIGTERM");
});
process.on("SIGTERM", () => {
  electron.kill("SIGTERM");
});
