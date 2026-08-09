// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Text } from "@harness-anything/kernel";
import {
  AuthorityCanonicalPublicationNotFoundError,
  createGitCanonicalPublicationInspector
} from "../src/authority/production/publication-evidence.ts";
import {
  readPublicationGitObject,
  shutdownPublicationGitObjectReader
} from "../src/authority/production/publication-object-reader.ts";
import { removeTemporaryTestRoot } from "../../../tools/test-temp-root-cleanup.mjs";

const posixTest = process.platform === "win32" ? test.skip : test;

test("concurrent object reads share one lazily spawned batch process", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-object-reader-"));
  context.after(async () => await removeTemporaryTestRoot(root));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");
  const tracePath = path.join(root, "git-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  const inspector = createGitCanonicalPublicationInspector(root);
  try {
    assert.equal(existsSync(tracePath), false);
    const results = await Promise.all(Array.from(
      { length: 8 },
      () => readPublicationGitObject(root, "HEAD:seed.txt")
    ));
    assert.deepEqual(results, Array.from({ length: 8 }, () => Buffer.from("seed\n")));
  } finally {
    await inspector.shutdown();
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }

  assert.equal(
    gitTraceCommands(tracePath).filter((args) =>
      args[0] === "cat-file" && args.includes("--batch")
    ).length,
    1
  );
});

posixTest("offset batch bytes fail closed and the request falls back to one-shot Git", async (context) => {
  const fixture = faultyPublicationRepo("offset");
  context.after(async () => await removeTemporaryTestRoot(fixture.root));
  try {
    assert.equal(
      await readPublicationGitObject(fixture.root, "HEAD:seed.txt").then((content) => content.toString("utf8")),
      "seed\n"
    );
  } finally {
    await shutdownPublicationGitObjectReader(fixture.root);
    fixture.restorePath();
  }

  const batchPids = readBatchPids(fixture.batchLog);
  assert.equal(batchPids.length, 2);
  assert.equal(new Set(batchPids).size, 2);
  assert.equal(readLogEntries(fixture.fallbackLog).length, 1);
});

posixTest("a batch process death falls back and creates only one replacement", async (context) => {
  const fixture = faultyPublicationRepo("die");
  context.after(async () => await removeTemporaryTestRoot(fixture.root));
  try {
    assert.equal(
      await readPublicationGitObject(fixture.root, "HEAD:seed.txt").then((content) => content.toString("utf8")),
      "seed\n"
    );
  } finally {
    await shutdownPublicationGitObjectReader(fixture.root);
    fixture.restorePath();
  }

  assert.equal(readBatchPids(fixture.batchLog).length, 2);
  assert.equal(readLogEntries(fixture.fallbackLog).length, 1);
});

posixTest("a half-read response never reaches the caller and falls back", async (context) => {
  const fixture = faultyPublicationRepo("half-read");
  context.after(async () => await removeTemporaryTestRoot(fixture.root));
  try {
    assert.equal(
      await readPublicationGitObject(fixture.root, "HEAD:seed.txt").then((content) => content.toString("utf8")),
      "seed\n"
    );
  } finally {
    await shutdownPublicationGitObjectReader(fixture.root);
    fixture.restorePath();
  }

  assert.equal(readBatchPids(fixture.batchLog).length, 2);
  assert.equal(readLogEntries(fixture.fallbackLog).length, 1);
});

posixTest("consecutive batch failures exhaust one rebuild and emit retry-budget escalation", async (context) => {
  const fixture = faultyPublicationRepo("offset");
  context.after(async () => await removeTemporaryTestRoot(fixture.root));
  const signals: Array<{ readonly phase: string; readonly operation: string }> = [];
  try {
    const results: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      results.push(await readPublicationGitObject(fixture.root, "HEAD:seed.txt", {
        onRetryBudgetSignal: (signal) => signals.push({
          phase: signal.phase,
          operation: signal.event.operation
        })
      })
        .then((content) => content.toString("utf8")));
    }
    assert.deepEqual(results, ["seed\n", "seed\n", "seed\n"]);
  } finally {
    await shutdownPublicationGitObjectReader(fixture.root);
    fixture.restorePath();
  }

  assert.equal(readBatchPids(fixture.batchLog).length, 2);
  assert.equal(readLogEntries(fixture.fallbackLog).length, 3);
  assert.deepEqual(signals, [{ phase: "exhausted", operation: "publication-git-object-batch" }]);
});

posixTest("shutdown terminates a stuck half-read and rejects queued requests", async (context) => {
  const fixture = faultyPublicationRepo("hang-half");
  context.after(async () => await removeTemporaryTestRoot(fixture.root));
  const active = readPublicationGitObject(fixture.root, "HEAD:seed.txt");
  const queued = readPublicationGitObject(fixture.root, "HEAD:seed.txt");
  const activeRejected = assert.rejects(active, /AUTHORITY_GIT_OBJECT_BATCH_HALF_READ/u);
  const queuedRejected = assert.rejects(queued, /AUTHORITY_GIT_OBJECT_READER_CLOSED/u);
  while (!existsSync(fixture.batchLog)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const shutdownStarted = performance.now();
  try {
    await shutdownPublicationGitObjectReader(fixture.root);
    assert.ok(performance.now() - shutdownStarted < 1_000);
    await Promise.all([activeRejected, queuedRejected]);
  } finally {
    fixture.restorePath();
  }

  assert.equal(readBatchPids(fixture.batchLog).length, 1);
  assert.equal(readLogEntries(fixture.fallbackLog).length, 0);
});

test("shutdown does not return while a batch descendant remains alive", async () => {
  const fixture = faultyPublicationRepo("descendant");
  let descendantPid: number | undefined;
  try {
    assert.equal(
      await readPublicationGitObject(fixture.root, "HEAD:seed.txt").then((content) => content.toString("utf8")),
      "seed\n"
    );
    descendantPid = Number(readLogEntries(fixture.descendantLog)[0]);
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.equal(isProcessAlive(descendantPid), true);

    await shutdownPublicationGitObjectReader(fixture.root);

    assert.equal(isProcessAlive(descendantPid), false, `batch descendant ${descendantPid} survived shutdown`);
  } finally {
    fixture.restorePath();
    if (descendantPid !== undefined) await waitForProcessExit(descendantPid, 2_000);
    await removeTemporaryTestRoot(fixture.root);
  }
});

test("publication evidence yields between blob reads so recovery admission timers remain live", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-evidence-responsive-"));
  context.after(async () => await removeTemporaryTestRoot(root));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");
  const previousCommit = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "-b", "session");
  const opId = "namespace:test-responsive-recovery";
  const semanticDigest = "a".repeat(64);
  mkdirSync(path.join(root, "attribution-events"));
  writeFileSync(
    path.join(root, "attribution-events", `${sha256Text(opId)}.jsonl`),
    `${JSON.stringify({
      schema: "attribution-event/v1",
      opId,
      authorityIntegrity: { semanticRequestDigest: semanticDigest }
    })}\n`
  );
  mkdirSync(path.join(root, "objects"));
  for (let index = 0; index < 16; index += 1) {
    writeFileSync(path.join(root, "objects", `${index}.txt`), `${index}\n`);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", `test: publication [${opId}]`);
  git(root, "checkout", "-q", "-");
  git(root, "merge", "-q", "--no-ff", "session", "-m", "materializer: merge session responsive");
  const mergeCommit = git(root, "rev-parse", "HEAD");

  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 0);
  const inspector = createGitCanonicalPublicationInspector(root);
  await inspector.inspectPublication(
    previousCommit,
    [opId],
    mergeCommit
  );
  await inspector.shutdown();
  const tracePath = path.join(root, "historical-publication-git-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  const historicalInspector = createGitCanonicalPublicationInspector(root);
  try {
    assert.deepEqual(await historicalInspector.findHistoricalPublicationForOperation(opId), {
      commitSha: mergeCommit,
      semanticDigest
    });
  } finally {
    await historicalInspector.shutdown();
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }

  const lookupCommands = gitTraceCommands(tracePath);
  assert.equal(lookupCommands.filter(([command]) => command === "rev-list").length, 0);
  assert.equal(lookupCommands.filter((args) =>
    args[0] === "show" && args.includes("-s")
  ).length, 0);
  assert.equal(lookupCommands.filter((args) =>
    args[0] === "diff" && args.includes("--quiet")
  ).length, 0);
  assert.equal(lookupCommands.filter((args) =>
    args[0] === "diff" && args.includes("--name-only")
  ).length, 1);
  assert.equal(lookupCommands.filter((args) =>
    args[0] === "show" && !args.includes("-s")
  ).length, 0);
  assert.equal(lookupCommands.filter((args) =>
    args[0] === "cat-file" && args.includes("--batch")
  ).length, 1);

  assert.equal(timerFired, true);
});

test("missing-operation recovery search yields and reuses one bounded history scan", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-evidence-history-"));
  context.after(async () => await removeTemporaryTestRoot(root));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");
  const historyRef = git(root, "symbolic-ref", "HEAD");
  const historyParent = git(root, "rev-parse", "HEAD");
  const historyTracePath = path.join(root, "history-construction-git-trace.jsonl");
  const previousHistoryTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = historyTracePath;
  try {
    appendLinearHistory(root, historyRef, historyParent, 2_048);
  } finally {
    if (previousHistoryTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousHistoryTrace;
  }
  assert.equal(
    gitTraceCommands(historyTracePath).length,
    1,
    "history fixture construction must use one bounded Git process"
  );

  let timerFired = false;
  const tracePath = path.join(root, "git-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  setTimeout(() => {
    timerFired = true;
  }, 0);
  try {
    const inspector = createGitCanonicalPublicationInspector(root);
    await assert.rejects(
      inspector.findPublicationForOperation("namespace:missing-publication"),
      AuthorityCanonicalPublicationNotFoundError
    );
    await assert.rejects(
      inspector.findPublicationForOperation("namespace:still-missing"),
      AuthorityCanonicalPublicationNotFoundError
    );
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }

  assert.equal(timerFired, true);
  const starts = gitTraceCommands(tracePath);
  assert.ok(starts.length <= 3, `expected one history scan plus HEAD checks, observed ${starts.length} Git processes`);
});

function gitTraceCommands(tracePath: string): ReadonlyArray<ReadonlyArray<string>> {
  return readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      readonly event: string;
      readonly argv?: ReadonlyArray<string>;
    })
    .filter((event) => event.event === "start")
    .map((event) => {
      const argv = event.argv ?? [];
      const rootFlag = argv.indexOf("-C");
      return rootFlag >= 0 ? argv.slice(rootFlag + 2) : argv.slice(1);
    });
}

function git(root: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function appendLinearHistory(
  root: string,
  ref: string,
  parent: string,
  count: number
): void {
  const commands: string[] = [];
  let from = parent;
  for (let index = 0; index < count; index += 1) {
    const mark = index + 1;
    const message = `history ${index}`;
    commands.push(
      `commit ${ref}`,
      `mark :${mark}`,
      `committer Harness Test <harness@example.test> ${mark} +0000`,
      `data ${Buffer.byteLength(message)}`,
      message,
      `from ${from}`,
      ""
    );
    from = `:${mark}`;
  }
  execFileSync("git", ["-C", root, "fast-import", "--quiet"], {
    input: commands.join("\n"),
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function readBatchPids(batchLog: string): ReadonlyArray<string> {
  return readLogEntries(batchLog);
}

function readLogEntries(logPath: string): ReadonlyArray<string> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
}

type GitBatchFault = "offset" | "die" | "half-read" | "hang-half" | "descendant";

function faultyPublicationRepo(fault: GitBatchFault): {
  readonly root: string;
  readonly batchLog: string;
  readonly descendantLog: string;
  readonly fallbackLog: string;
  readonly restorePath: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), `publication-object-${fault}-`));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const binDir = path.join(root, "fault-bin");
  const batchLog = path.join(root, "batch-starts.log");
  const descendantLog = path.join(root, "batch-descendants.log");
  const fallbackLog = path.join(root, "fallback-starts.log");
  mkdirSync(binDir);
  const wrapper = path.join(binDir, "git");
  writeFileSync(wrapper, faultyGitWrapperSource(realGit, batchLog, descendantLog, fallbackLog, fault));
  chmodSync(wrapper, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  return {
    root,
    batchLog,
    descendantLog,
    fallbackLog,
    restorePath: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  };
}

function faultyGitWrapperSource(
  realGit: string,
  batchLog: string,
  descendantLog: string,
  fallbackLog: string,
  fault: GitBatchFault
): string {
  return [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    'import { spawn, spawnSync } from "node:child_process";',
    `const realGit = ${JSON.stringify(realGit)};`,
    `const batchLog = ${JSON.stringify(batchLog)};`,
    `const descendantLog = ${JSON.stringify(descendantLog)};`,
    `const fallbackLog = ${JSON.stringify(fallbackLog)};`,
    `const fault = ${JSON.stringify(fault)};`,
    "const args = process.argv.slice(2);",
    "if (!args.includes(\"--batch\")) {",
    "  appendFileSync(fallbackLog, `${process.pid}\\n`);",
    "  const delegated = spawnSync(realGit, args, { stdio: \"inherit\" });",
    "  process.exit(delegated.status ?? 1);",
    "}",
    "appendFileSync(batchLog, `${process.pid}\\n`);",
    "const rootFlag = args.indexOf(\"-C\");",
    "const root = rootFlag >= 0 ? args[rootFlag + 1] : process.cwd();",
    "if (fault === \"descendant\") {",
    "  const descendant = spawn(process.execPath, [\"-e\", \"setTimeout(() => {}, 1500)\"], { cwd: root, stdio: \"ignore\" });",
    "  descendant.unref();",
    "  appendFileSync(descendantLog, `${descendant.pid}\\n`);",
    "}",
    "let pending = \"\";",
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.on(\"data\", (chunk) => {",
    "  pending += chunk;",
    "  const newline = pending.indexOf(\"\\n\");",
    "  if (newline < 0) return;",
    "  const objectName = pending.slice(0, newline);",
    "  if (fault === \"die\") process.exit(17);",
    "  const contentResult = spawnSync(realGit, [\"-C\", root, \"show\", objectName]);",
    "  const oidResult = spawnSync(realGit, [\"-C\", root, \"rev-parse\", objectName], { encoding: \"utf8\" });",
    "  const typeResult = spawnSync(realGit, [\"-C\", root, \"cat-file\", \"-t\", objectName], { encoding: \"utf8\" });",
    "  if (contentResult.status !== 0 || oidResult.status !== 0 || typeResult.status !== 0) process.exit(2);",
    "  const content = Buffer.from(contentResult.stdout);",
    "  const corrupted = fault === \"offset\"",
    "    ? Buffer.concat([content.subarray(1), content.subarray(0, 1)])",
    "    : fault === \"half-read\" || fault === \"hang-half\" ? content.subarray(0, -1)",
    "    : content;",
    "  process.stdout.write(`${oidResult.stdout.trim()} ${typeResult.stdout.trim()} ${content.length}\\n`);",
    "  process.stdout.write(corrupted);",
    "  if (fault === \"hang-half\") setTimeout(() => process.exit(0), 2_000);",
    "  else process.stdout.write(\"\\n\", () => { if (fault === \"half-read\") process.exit(0); });",
    "});",
    ""
  ].join("\n");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (performance.now() >= deadline) {
      throw new Error(`test-owned batch descendant did not exit: pid=${pid}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
