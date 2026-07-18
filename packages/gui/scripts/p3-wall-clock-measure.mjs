/**
 * PLT-Performance/P3 — REAL Electron wall-clock measurement.
 *
 * Measures cold launch-to-first-usable, warm re-entry, DOM, long tasks, heap/RSS
 * for Overview + Execution Evidence at 100/1000/5000 × 1/5 outputs.
 *
 * Usage:
 *   node packages/gui/scripts/p3-wall-clock-measure.mjs \
 *     --sizes 100,1000,5000 --outputs 1,5 \
 *     --out-dir /path/to/artifacts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  guiRoot,
  repoRoot,
  measureCase,
  runProjectionLayer,
} from "./p3-wall-clock-measure-lib.mjs";
import {
  COLD_TARGET_MS,
  WARM_TARGET_MS,
  DOM_CEILING,
  PRE_FIX,
  buildMarkdown,
} from "./p3-wall-clock-report.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const sizes = parseList("--sizes", [100, 1000, 5000]);
const outputsList = parseList("--outputs", [1, 5]);
const outDir = flagValue("--out-dir")
  ?? resolve(
    scriptDir,
    "../../../../../harness/tasks/task_01KXVFC7QDNHKTMS9S5XWXQYSD-revive-gui-bounded/artifacts",
  );
const skipProjection = process.argv.includes("--skip-projection");
const onlySizes = process.argv.includes("--quick") ? [100] : sizes;

mkdirSync(outDir, { recursive: true });

function parseList(flag, fallback) {
  const raw = flagValue(flag);
  if (!raw) return fallback;
  return raw.split(",").map((v) => {
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} expects positive ints`);
    return n;
  });
}

function flagValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

async function main() {
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const host = `${process.platform} ${process.arch} node=${process.version}`;

  // Ensure dist exists
  if (!existsSync(path.join(guiRoot, "dist", "index.html"))) {
    console.error("[p3-wall] building renderer…");
    const b = spawnSync("npm", ["run", "build", "-w", "@harness-anything/gui"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (b.status !== 0) throw new Error("gui build failed");
  }
  if (!existsSync(path.join(guiRoot, "dist-electron", "electron-preload.cjs"))) {
    console.error("[p3-wall] building preload…");
    const b = spawnSync("npm", ["run", "build:preload", "-w", "@harness-anything/gui"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (b.status !== 0) throw new Error("preload build failed");
  }

  const matrix = [];
  const blockers = [];

  for (const size of onlySizes) {
    for (const outputs of outputsList) {
      // Skip 5000×5 if not requested specially — still run all by default.
      const caseResult = await measureCase(size, outputs);
      if (!skipProjection) {
        try {
          caseResult.layers = {
            projectionTransport: runProjectionLayer(size, outputs),
          };
        } catch (error) {
          caseResult.layers = {
            projectionTransport: { ok: false, error: error.message },
          };
          blockers.push(`projection layer ${size}x${outputs}: ${error.message}`);
        }
      } else {
        caseResult.layers = { projectionTransport: { ok: false, error: "skipped" } };
      }
      if (caseResult.error) {
        blockers.push(
          `Electron wall-clock ${caseResult.label}: ${caseResult.error.message}`,
        );
      }
      matrix.push(caseResult);

      // Persist incrementally so partial runs still leave evidence.
      const partial = {
        schema: "plt-performance-p3-gui-wall-clock/v1",
        generatedAt: new Date().toISOString(),
        headSha,
        host,
        matrix,
        blockers,
        partial: true,
      };
      writeFileSync(
        path.join(outDir, "p3-wall-clock-matrix.partial.json"),
        `${JSON.stringify(partial, null, 2)}\n`,
      );
    }
  }

  const artifact = {
    schema: "plt-performance-p3-gui-wall-clock/v1",
    generatedAt: new Date().toISOString(),
    headSha,
    host,
    method: {
      driver: "playwright-core _electron",
      entry: "packages/gui/src/main/electron-main.ts",
      firstUsableSelector: '[data-first-usable="true"][data-first-usable-view]',
      coldTargetMs: COLD_TARGET_MS,
      warmTargetMs: WARM_TARGET_MS,
      domCeiling: DOM_CEILING,
    },
    preFixBaselines: PRE_FIX,
    matrix,
    blockers,
    summary: {
      allElectronOk: matrix.every((r) => !r.error),
      allEeColdMet: matrix
        .filter((r) => !r.error)
        .every((r) => r.goals.executionsColdFirstNavMet),
      allEeWarmMet: matrix
        .filter((r) => !r.error)
        .every((r) => r.goals.executionsWarmReentryMet),
      allDomMet: matrix
        .filter((r) => !r.error)
        .every((r) => r.goals.overviewDomMet && r.goals.executionsDomMet),
    },
  };

  const jsonPath = path.join(outDir, "p3-wall-clock-matrix.json");
  const mdPath = path.join(outDir, "p3-wall-clock-matrix.md");
  writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(mdPath, buildMarkdown(artifact));
  console.error(`[p3-wall] wrote ${jsonPath}`);
  console.error(`[p3-wall] wrote ${mdPath}`);
  process.stdout.write(`${JSON.stringify({ jsonPath, mdPath, summary: artifact.summary }, null, 2)}\n`);
  if (blockers.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error("[p3-wall] fatal:", error);
  process.exit(1);
});

