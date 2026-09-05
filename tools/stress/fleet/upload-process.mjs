import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const childScript = path.resolve(
  import.meta.dirname,
  "../../../packages/daemon/test/stress/fleet/upload-client.fixture.mjs",
);

export function spawnUploadProcess(fixture, center, assignment, options) {
  const childRoot = path.join(fixture.root, "upload-children", options.label),
    configFile = path.join(childRoot, "config.json"),
    bodyFile = path.join(childRoot, "body"),
    boundaryFile = path.join(childRoot, "boundary.json"),
    readyFile = path.join(childRoot, "ready"),
    resultFile = path.join(childRoot, "result.json"),
    emptyPath = path.join(childRoot, "empty-path");
  mkdirSync(emptyPath, { recursive: true });
  writeFileSync(bodyFile, options.body);
  writeFileSync(
    configFile,
    JSON.stringify({
      port: center.port,
      caFile: fixture.certFile,
      nodeId: assignment.nodeId,
      credential: `credential-${assignment.nodeId}`,
      assignmentId: assignment.assignmentId,
      path: options.path,
      bodyFile,
      boundaryFile,
      resultFile,
      baseLedgerSha: options.baseLedgerSha,
      baseBlobSha256: options.baseBlobSha256 ?? null,
      pauseAt: options.pauseAt ?? null,
      readyFile: options.barrier ? readyFile : null,
    }),
  );
  const child = spawn(process.execPath, [childScript, configFile], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: { ...process.env, PATH: emptyPath },
      stdio: ["pipe", "pipe", "pipe"],
    }),
    output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output.stderr += chunk;
  });
  return {
    child,
    boundaryFile,
    readyFile,
    resultFile,
    output,
    release: () => child.stdin.end("go\n"),
  };
}

export async function waitForMarker(file, child, output, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`upload child exited before marker: ${output.stderr || output.stdout}`);
    if (Date.now() >= deadline) throw new Error(`upload child marker timed out: ${file}`);
    await delay(20);
  }
  return readFileSync(file, "utf8").trim();
}

export async function killPausedUpload(run) {
  run.child.kill("SIGKILL");
  const exit = await waitForExit(run.child);
  assert.equal(exit.signal, "SIGKILL", run.output.stderr);
  return exit;
}

export async function completedUpload(run) {
  const exit = await waitForExit(run.child);
  assert.equal(exit.code, 0, run.output.stderr);
  return JSON.parse(await waitForMarker(run.resultFile, run.child, run.output));
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
