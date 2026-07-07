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
const electronPath = require("electron");

function log(message) {
  console.log(`[dev-electron] ${message}`);
}

log("building preload bundle...");
const preloadBuild = spawnSync("npx", ["vite", "build", "--config", "vite.preload.config.ts"], {
  cwd: guiRoot,
  stdio: "inherit"
});
if (preloadBuild.status !== 0) {
  console.error("[dev-electron] preload build failed");
  process.exit(preloadBuild.status ?? 1);
}

log(`starting renderer dev server at ${rendererUrl} ...`);
const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
  cwd: guiRoot,
  env: { ...process.env, BROWSER: "none" },
  stdio: ["ignore", "pipe", "pipe"]
});
vite.stderr.on("data", (chunk) => process.stderr.write(chunk));

async function waitForRenderer() {
  const deadline = Date.now() + 30_000;
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
  if (await Promise.race([closed, timedOut]) === "timeout") {
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
    HARNESS_GUI_ROOT: process.env.HARNESS_GUI_ROOT ?? repoRoot
  },
  stdio: "inherit"
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
