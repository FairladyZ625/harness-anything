import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator } from "../packages/kernel/src/store/write-journal-coordinator.ts";

const defaultWriters = 4;
const writesPerWriter = 4;
const workerArg = process.argv.indexOf("--worker");

if (workerArg >= 0) {
  await runWorker(process.argv[workerArg + 1], Number(process.argv[workerArg + 2]));
} else {
  await runBench();
}

async function runBench() {
  const writers = numberOption("--writers", defaultWriters);
  const rootDir = mkdtempSync(path.join(tmpdir(), "receipt-honesty-"));
  const keep = process.argv.includes("--keep");
  try {
    mkdirSync(path.join(rootDir, "harness", "tasks"), { recursive: true });
    const children = Array.from({ length: writers }, (_, writer) => spawn(
      process.execPath,
      [import.meta.filename, "--worker", rootDir, String(writer)],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    ));

    await waitFor(() => Array.from({ length: writers }, (_, writer) => path.join(rootDir, `.ready-${writer}`)).every(existsSync));
    writeFileSync(path.join(rootDir, ".start"), "start\n");
    const rows = (await Promise.all(children.map(readChild))).flat();
    const watermark = JSON.parse(readFileSync(path.join(rootDir, ".harness", "write-journal", "watermark.json"), "utf8"));
    const committed = new Set(watermark.lastCommittedOpIds ?? []);
    const classified = rows.map((row) => ({
      ...row,
      artifactPresent: existsSync(path.join(rootDir, "harness", "tasks", row.taskId, "receipt.md")),
      watermarkPresent: committed.has(row.opId)
    }));
    const durable = classified.filter((row) => row.artifactPresent && row.watermarkPresent).length;
    const receiptOk = classified.filter((row) => row.receiptOk).length;
    const falseNegative = classified.filter((row) => !row.receiptOk && row.artifactPresent && row.watermarkPresent).length;
    const falsePositive = classified.filter((row) => row.receiptOk && (!row.artifactPresent || !row.watermarkPresent)).length;
    process.stdout.write(`${JSON.stringify({
      schema: "receipt-honesty-bench/v1",
      rootDir,
      writers,
      writesPerWriter,
      totals: { attempts: classified.length, receiptOk, durable, falseNegative, falsePositive },
      rows: classified
    }, null, 2)}\n`);
  } finally {
    if (!keep) rmSync(rootDir, { recursive: true, force: true });
  }
}

async function runWorker(rootDir, writer) {
  if (!rootDir || !Number.isInteger(writer)) throw new Error("invalid worker arguments");
  const opIds = Array.from({ length: writesPerWriter }, (_, index) => `receipt-w${writer}-n${index}`);
  const coordinator = makeJournaledWriteCoordinator({
    rootDir,
    attribution: {
      actor: {
        principal: { kind: "person", personId: "person_test" },
        executor: { kind: "agent", id: `receipt-writer-${writer}` }
      },
      principalSource: { kind: "local-configured", authority: "harness.yaml", authoritySha256: "sha256:receipt-bench" },
      executorSource: "client-asserted"
    },
    lockConflictRetry: { maxWaitMs: 100, initialDelayMs: 5, maxDelayMs: 10 },
    autoMaterialize: false,
    versionControlSystem: slowVersionControlSystem(rootDir)
  });
  for (let index = 0; index < writesPerWriter; index += 1) {
    const taskId = `task-receipt-w${writer}-n${index}`;
    Effect.runSync(coordinator.enqueue({
      opId: opIds[index],
      entityId: `task/${taskId}`,
      kind: "doc_write",
      payload: { path: "receipt.md", body: `${taskId}\n` }
    }));
  }
  writeFileSync(path.join(rootDir, `.ready-${writer}`), "ready\n");
  await waitFor(() => existsSync(path.join(rootDir, ".start")));
  const result = await Effect.runPromise(Effect.either(coordinator.flush("explicit")));
  const receiptOk = result._tag === "Right";
  for (let index = 0; index < writesPerWriter; index += 1) {
    process.stdout.write(`${JSON.stringify({
      writer,
      index,
      taskId: `task-receipt-w${writer}-n${index}`,
      opId: opIds[index],
      receiptOk,
      errorTag: result._tag === "Left" ? result.left._tag : undefined
    })}\n`);
  }
}

function slowVersionControlSystem(rootDir) {
  const harnessRoot = path.join(rootDir, "harness");
  return {
    normalizePath: (inputPath) => path.resolve(inputPath),
    topLevel: (inputPath) => path.resolve(inputPath).startsWith(`${harnessRoot}${path.sep}`) || path.resolve(inputPath) === harnessRoot ? harnessRoot : rootDir,
    isIgnored: () => false,
    add: () => undefined,
    workingTreeFiles: () => "",
    stagedFiles: () => "tasks/receipt.md\n",
    commit: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500),
    currentHead: () => "fake-durable-head",
    currentBranch: () => "main",
    originHeadBranch: () => null,
    refExists: (_repoRoot, ref) => ref === "refs/heads/main" || ref === "main",
    commitExists: () => true,
    pathExistsAtCommit: () => true,
    checkout: () => undefined,
    createBranch: () => undefined,
    mergeNoFf: () => undefined,
    deleteBranch: () => undefined,
    abortMerge: () => undefined,
    sessionBranches: () => [],
    commitsNotInTrunk: () => [],
    changedFilesBetween: () => [],
    resetQuiet: () => undefined
  };
}

async function readChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw new Error(`worker failed (${String(code)}/${String(signal)}): ${stderr}`);
  return stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 10_000) throw new Error("timed out waiting for bench barrier");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function numberOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
