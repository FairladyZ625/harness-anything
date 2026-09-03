#!/usr/bin/env node
// Package-local hot-reload launcher for GUI development. Production users run
// `ha gui`, which builds file-backed renderer assets and owns no Vite server.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const guiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(guiRoot, "../..");
const rendererPort = process.env.HARNESS_GUI_DEV_PORT ?? "5173";
const rendererUrl = `http://127.0.0.1:${rendererPort}`;

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
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", rendererPort, "--strictPort"], {
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
      throw new Error(`renderer dev server exited early with code ${vite.exitCode} (is port ${rendererPort} busy?)`);
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

let shuttingDown = false;
const shutdown = async (code) => {
  shuttingDown = true;
  await stopVite();
  process.exit(code);
};
electron.on("close", (code) => void shutdown(code ?? 0));
// Lifecycle symmetry: the launcher already stops Vite when Electron closes. The reverse was missing —
// if the Vite dev server died (crash, or the launcher's own vite child getting killed) while Electron
// stayed up, Electron kept rendering a dead http://127.0.0.1:5173 as an unrecoverable black window
// with no error. Tear Electron down loudly instead so the failure is visible and there is no orphan.
vite.on("close", (code) => {
  if (shuttingDown) return;
  console.error(
    `[dev-electron] renderer dev server exited unexpectedly (code ${code}); ` +
      "shutting down Electron to avoid an orphaned black window. Re-run 'npm run dev:electron'.",
  );
  electron.kill("SIGTERM");
  process.exit(code ?? 1);
});
process.on("SIGINT", () => {
  electron.kill("SIGTERM");
});
process.on("SIGTERM", () => {
  electron.kill("SIGTERM");
});
