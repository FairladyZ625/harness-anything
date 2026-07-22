import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Effect } from "effect";
import { landedSettingDefaults } from "@harness-anything/kernel";
import { makeJournaledWriteCoordinator } from "../packages/kernel/src/write-coordination/journal/coordinator.ts";

const defaultWriters = 4;
const writesPerWriter = 4;
const workerArg = process.argv.indexOf("--worker");

if (path.resolve(process.argv[1] ?? "") === import.meta.filename) {
  if (workerArg >= 0) {
    await runWorker(process.argv[workerArg + 1], Number(process.argv[workerArg + 2]), JSON.parse(process.argv[workerArg + 3]));
  } else {
    await runBench();
  }
}

async function runBench() {
  const writers = numberOption("--writers", defaultWriters);
  const policy = resolveReceiptHonestyBenchPolicy(process.argv, process.env);
  const rootDir = mkdtempSync(path.join(tmpdir(), "receipt-honesty-"));
  const keep = process.argv.includes("--keep");
  try {
    mkdirSync(path.join(rootDir, "harness", "tasks"), { recursive: true });
    const children = Array.from({ length: writers }, (_, writer) => spawn(
      process.execPath,
      [import.meta.filename, "--worker", rootDir, String(writer), JSON.stringify(policy)],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    ));

    await waitFor(() => Array.from({ length: writers }, (_, writer) => path.join(rootDir, `.ready-${writer}`)).every(existsSync), policy);
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

async function runWorker(rootDir, writer, policy) {
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
    lockConflictRetry: policy.lockConflictRetry,
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
  await waitFor(() => existsSync(path.join(rootDir, ".start")), policy);
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

async function waitFor(predicate, policy) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > policy.barrierTimeoutMs) throw new Error("timed out waiting for bench barrier");
    await new Promise((resolve) => setTimeout(resolve, policy.barrierPollMs));
  }
}

export function resolveReceiptHonestyBenchPolicy(argv = process.argv, env = process.env) {
  const value = (flag, envName, fallback, maximum) => {
    const flagIndex = argv.indexOf(flag);
    const raw = flagIndex >= 0 ? argv[flagIndex + 1] : env[envName];
    if (raw === undefined) return fallback;
    if (!/^[0-9]+$/u.test(raw)) throw new Error(`${flag} / ${envName} must be a positive integer`);
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
      throw new Error(`${flag} / ${envName} must be between 1 and ${maximum}`);
    }
    return parsed;
  };
  const lockConflictRetry = {
    maxWaitMs: value("--lock-max-wait-ms", "HARNESS_BENCH_LOCK_MAX_WAIT_MS", landedSettingDefaults.benchLockMaxWaitMs, 60_000),
    initialDelayMs: value("--lock-initial-delay-ms", "HARNESS_BENCH_LOCK_INITIAL_DELAY_MS", landedSettingDefaults.benchLockInitialDelayMs, 10_000),
    maxDelayMs: value("--lock-max-delay-ms", "HARNESS_BENCH_LOCK_MAX_DELAY_MS", landedSettingDefaults.benchLockMaxDelayMs, 10_000)
  };
  if (lockConflictRetry.initialDelayMs > lockConflictRetry.maxDelayMs) {
    throw new Error("benchmark lock initial delay must not exceed max delay");
  }
  return {
    lockConflictRetry,
    barrierTimeoutMs: value("--barrier-timeout-ms", "HARNESS_BENCH_BARRIER_TIMEOUT_MS", landedSettingDefaults.benchBarrierTimeoutMs, 120_000),
    barrierPollMs: value("--barrier-poll-ms", "HARNESS_BENCH_BARRIER_POLL_MS", landedSettingDefaults.benchBarrierPollMs, 10_000)
  };
}

function numberOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
