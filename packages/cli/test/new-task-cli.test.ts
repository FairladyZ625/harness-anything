// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;
const noAgentRuntimeEnv = {
  CLAUDE_SESSION_ID: "",
  CLAUDE_CODE_SESSION_ID: "",
  CODEX_SESSION_ID: "",
  CODEX_THREAD_ID: "",
  ZCODE_SESSION_ID: "",
  ANTIGRAVITY_SESSION_ID: ""
};
const testActorEnv = { HARNESS_ACTOR: "agent:new-task-cli-test" } as const;

test("CLI init dogfoods coding vertical defaults for new tasks", () => {
  withTempRoot((rootDir) => {
    rmSync(path.join(rootDir, "harness"), { recursive: true, force: true });
    runJson(rootDir, ["init"]);
    configureTestIdentity(rootDir);
    assert.equal(existsSync(path.join(rootDir, "harness/adr")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/milestones")), true);

    const result = runJson(rootDir, ["new-task", "--title", "Dogfood Task"], true, noAgentRuntimeEnv);
    const taskId = assertGeneratedTaskId(result.taskId);
    const index = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-dogfood-task/INDEX.md`), "utf8");
    const contract = JSON.parse(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-dogfood-task/task-contract.json`), "utf8"));

    assert.equal(result.ok, true);
    assert.equal(result.report.vertical, "software/coding");
    assert.equal(result.report.preset, "standard-task");
    assert.equal(result.report.profile, "baseline");
    assert.equal(result.generated.includes("task_plan.md"), true);
    assert.equal(result.generated.includes("task-contract.json"), true);
    assert.equal(result.generated.includes("read_set.md"), false);
    assert.equal(result.generated.some((entry: string) => entry.startsWith("references/")), false);
    assert.equal(existsSync(path.join(rootDir, result.packagePath, "read_set.md")), false);
    assert.equal(existsSync(path.join(rootDir, result.packagePath, "references")), false);
    assert.match(index, /vertical: software\/coding/);
    assert.match(index, /preset: standard-task/);
    assert.match(index, /profile: baseline/);
    assert.equal(contract.schema, "task-contract-snapshot/v1");
    assert.equal(contract.preset.id, "standard-task");
    assert.equal(contract.profile.id, "baseline");
    assert.deepEqual(contract.profile.completionGates, ["ci", "code-doc-reconciliation"]);
    assert.equal(contract.capturedBy, "task-create");
    assert.equal(Object.hasOwn(contract, "entrypoints"), false);
    assertHumanProvenance(rootDir, index);
  });
});

test("CLI reference-task preset materializes localized references on demand", () => {
  withTempRoot((rootDir) => {
    const listed = runJson(rootDir, ["preset", "list"]);
    assert.equal(listed.presets.some((preset: Record<string, unknown>) => preset.id === "reference-task"), true);

    for (const testCase of [
      { locale: "zh-CN", title: "Chinese References", expected: /列出设计、需求、审查和外部上下文/u },
      { locale: "en-US", title: "English References", expected: /List design, requirement, review, and external context/u }
    ]) {
      const result = runJson(rootDir, [
        "task",
        "create",
        "--title",
        testCase.title,
        "--vertical",
        "software/coding",
        "--preset",
        "reference-task",
        "--locale",
        testCase.locale
      ], true, noAgentRuntimeEnv);
      const referencesPath = path.join(rootDir, result.packagePath, "references", "INDEX.md");

      assert.equal(result.generated.includes("references/INDEX.md"), true);
      assert.equal(existsSync(referencesPath), true);
      assert.match(readFileSync(referencesPath, "utf8"), testCase.expected);
    }
  });
});

test("CLI task readers keep existing references directories compatible", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, [
      "task",
      "create",
      "--title",
      "Legacy References",
      "--vertical",
      "software/coding",
      "--preset",
      "standard-task"
    ], true, noAgentRuntimeEnv);
    const legacyReferencePath = path.join(rootDir, created.packagePath, "references", "legacy-input.md");
    mkdirSync(path.dirname(legacyReferencePath), { recursive: true });
    writeFileSync(legacyReferencePath, "# Legacy input\n", "utf8");

    const shown = runJson(rootDir, ["task", "show", created.taskId]);
    writeSubstantiveTaskPlan(rootDir, String(created.packagePath));
    const checked = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);

    assert.equal(shown.report.task.taskId, created.taskId);
    assert.equal(shown.report.task.status, "planned");
    assert.equal(checked.ok, true);
    assert.equal(checked.report.summary.hardFailCount, 0);
    assert.equal(readFileSync(legacyReferencePath, "utf8"), "# Legacy input\n");
  });
});

test("CLI check reads a created task contract without the mutable preset registry", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, [
      "task",
      "create",
      "--title",
      "Frozen Contract",
      "--vertical",
      "software/coding",
      "--preset",
      "standard-task"
    ], true, noAgentRuntimeEnv);
    writeSubstantiveTaskPlan(rootDir, String(created.packagePath));

    const overrideDir = path.join(rootDir, ".harness", "presets", "standard-task");
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(path.join(overrideDir, "preset.json"), "{}\n", "utf8");

    const checked = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);
    assert.equal(checked.ok, true);
    assert.equal(checked.report.summary.hardFailCount, 0);
  });
});

test("CLI task contract migration is dry-run safe, idempotent, and queues ambiguous tasks", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const migratable = runJson(rootDir, ["task", "create", "--title", "Legacy Explicit", "--vertical", "software/coding", "--preset", "standard-task"] , true, noAgentRuntimeEnv);
    const ambiguous = runJson(rootDir, ["task", "create", "--title", "Legacy Ambiguous", "--vertical", "software/coding", "--preset", "standard-task"], true, noAgentRuntimeEnv);
    const unverified = runJson(rootDir, ["task", "create", "--title", "Legacy Unverified", "--vertical", "software/coding", "--preset", "standard-task"], true, noAgentRuntimeEnv);
    const migratableContract = path.join(rootDir, migratable.packagePath, "task-contract.json");
    const ambiguousContract = path.join(rootDir, ambiguous.packagePath, "task-contract.json");
    const unverifiedContract = path.join(rootDir, unverified.packagePath, "task-contract.json");
    const unverifiedSnapshot = JSON.parse(readFileSync(unverifiedContract, "utf8")) as { documents: ReadonlyArray<{ materializeAs: string }> };
    rmSync(migratableContract, { force: true });
    rmSync(ambiguousContract, { force: true });
    rmSync(unverifiedContract, { force: true });
    const ambiguousIndex = path.join(rootDir, ambiguous.packagePath, "INDEX.md");
    writeFileSync(ambiguousIndex, readFileSync(ambiguousIndex, "utf8").replace("preset: standard-task", "preset: missing-preset"), "utf8");
    writeSubstantiveTaskPlan(rootDir, String(unverified.packagePath));
    for (const document of unverifiedSnapshot.documents) {
      const documentPath = path.join(rootDir, unverified.packagePath, document.materializeAs);
      writeFileSync(documentPath, `${readFileSync(documentPath, "utf8")}\nUnverified authored content.\n`, "utf8");
    }
    const harnessRoot = path.join(rootDir, "harness");
    const unverifiedRelativePath = path.relative(harnessRoot, path.join(rootDir, unverified.packagePath));
    execFileSync("git", ["-C", harnessRoot, "add", "-A", "--", unverifiedRelativePath]);
    execFileSync("git", ["-C", harnessRoot, "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "--amend", "--no-edit"], { stdio: "ignore" });

    const preview = runJson(rootDir, ["task", "contract", "migrate", "--dry-run"]);
    assert.equal(preview.report.counts.planned, 1, JSON.stringify(preview.report));
    assert.equal(preview.report.counts.manual, 2);
    assert.equal(preview.report.entries.find((entry: { taskId: string }) => entry.taskId === unverified.taskId)?.reason, "contract_provenance_unverified");
    assert.equal(existsSync(migratableContract), false);
    assert.equal(existsSync(ambiguousContract), false);
    assert.equal(existsSync(unverifiedContract), false);

    const applied = runJson(rootDir, ["task", "contract", "migrate", "--apply"]);
    assert.equal(applied.report.counts.applied, 1);
    assert.equal(applied.report.counts.manual, 2);
    assert.equal(JSON.parse(readFileSync(migratableContract, "utf8")).capturedBy, "legacy-migration");
    assert.equal(existsSync(ambiguousContract), false);
    assert.equal(existsSync(unverifiedContract), false);

    const repeated = runJson(rootDir, ["task", "contract", "migrate", "--apply"]);
    assert.equal(repeated.report.counts.applied, 0);
    assert.equal(repeated.report.counts.current, 1);
    assert.equal(repeated.report.counts.manual, 2);

    const mismatched = JSON.parse(readFileSync(migratableContract, "utf8"));
    mismatched.preset.id = "different-preset";
    writeFileSync(migratableContract, `${JSON.stringify(mismatched, null, 2)}\n`, "utf8");
    const mismatchPreview = runJson(rootDir, ["task", "contract", "migrate", "--dry-run", "--task", migratable.taskId]);
    assert.equal(mismatchPreview.report.counts.manual, 1);
    assert.equal(mismatchPreview.report.entries[0].reason, "existing_snapshot_metadata_mismatch");
  });
});

test("CLI task contract migration uses source Git history plus actual scaffold evidence", () => {
  withTempRoot((rootDir) => {
    const sourceCommit = seedSoftwareCodingAssetHistory(rootDir);
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, [
      "task", "create", "--title", "Historical Contract", "--vertical", "software/coding", "--preset", "standard-task"
    ], true, noAgentRuntimeEnv);
    const contractPath = path.join(rootDir, created.packagePath, "task-contract.json");
    rmSync(contractPath, { force: true });
    writeSubstantiveTaskPlan(rootDir, String(created.packagePath));

    const preview = runJson(rootDir, ["task", "contract", "migrate", "--dry-run", "--task", created.taskId]);
    assert.equal(preview.report.counts.planned, 1, JSON.stringify(preview.report));
    assert.equal(preview.report.counts.manual, 0);
    assert.equal(preview.report.entries[0].provenance, "source-git-history");
    assert.equal(preview.report.entries[0].sourceCommit, sourceCommit);
    assert.equal(existsSync(contractPath), false);
  });
});

test("CLI creates a local task with generated identity, provenance, and stable JSON output", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["new-task", "--title", "Task One"], true, noAgentRuntimeEnv);
    const taskId = assertGeneratedTaskId(result.taskId);
    const index = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/INDEX.md`), "utf8");

    assert.equal(result.ok, true);
    assert.equal(result.command, "new-task");
    assert.equal(result.slug, "task-one");
    assert.equal(result.status, "planned");
    assert.equal(result.packagePath, `harness/tasks/${taskId}-task-one`);
    assert.equal(result.paths.package, result.packagePath);
    assert.equal(existsSync(path.join(rootDir, result.packagePath, "task-contract.json")), true);
    assert.match(index, /engine: local/);
    assertHumanProvenance(rootDir, index);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /"projectionHash":"sha256:/);
    assert.match(runText(rootDir, ["new-task", "--title", "Text Path"]), /ok command="task create" task=task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26} status=planned path=harness\/tasks\/task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}-text-path summary=/u);
  });
});

test("CLI task create persists work kind and priority metadata", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["task", "create", "--title", "Metadata Task", "--kind", "feat", "--risk-tier", "high", "--urgency", "low"], true, noAgentRuntimeEnv);
    const taskId = assertGeneratedTaskId(result.taskId);
    const index = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-metadata-task/INDEX.md`), "utf8");

    assert.match(index, /^workKind: feat$/mu);
    assert.match(index, /^riskTier: high$/mu);
    assert.match(index, /^urgency: low$/mu);
  });
});

test("CLI task create keeps runtime provenance without fabricating a missing transcript", () => {
  withTempRoot((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const sessionId = "019f32b3-0c38-7720-841d-b41048092cc8";
    mkdirSync(harnessRoot, { recursive: true });
    initHarnessGit(harnessRoot);

    const result = runJson(rootDir, [
      "new-task",
      "--title",
      "Runtime Provenance",
      "--vertical",
      "software/coding",
      "--preset",
      "standard-task"
    ], true, {
      ...noAgentRuntimeEnv,
      CODEX_THREAD_ID: sessionId,
      HOME: path.join(rootDir, "home")
    });
    const taskId = assertGeneratedTaskId(result.taskId);
    const index = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-runtime-provenance/INDEX.md`), "utf8");
    const sessionPath = path.join(harnessRoot, "sessions", `${sessionId}.md`);

    assert.match(index, new RegExp(`sessionId: "${sessionId}"`, "u"));
    assert.equal(existsSync(sessionPath), false);
    assert.doesNotMatch(gitLog(harnessRoot), new RegExp(`session-export-${sessionId}-[a-f0-9]{16}`, "u"));
    assert.equal(gitStatus(harnessRoot), "");
  });
});

function assertHumanProvenance(rootDir: string, index: string): void {
  assert.match(index, /provenance:\n  - \{runtime: "human", sessionId: "human-cli-\d+", boundAt: "\d{4}-\d{2}-\d{2}T/u);
  const sessionId = /sessionId: "(human-cli-\d+)"/u.exec(index)?.[1];
  assert.ok(sessionId);
  const sessionManifest = JSON.parse(readFileSync(path.join(rootDir, "harness", "sessions", `${sessionId}.md`), "utf8")) as { schema: string; sessionId: string; runtime: string };
  assert.equal(sessionManifest.schema, "session-entity/v1");
  assert.equal(sessionManifest.sessionId, sessionId);
  assert.equal(sessionManifest.runtime, "human");
}

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_DAEMON_MODE: "direct",
        HARNESS_DIRECT_WRITE_REASON: "test",
        ...testActorEnv,
        ...env
      }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function runText(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): string {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_DAEMON_MODE: "direct",
        HARNESS_DIRECT_WRITE_REASON: "test",
        ...testActorEnv
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    return stdout;
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stderr?: string };
    return failure.stderr ?? "";
  }
}

function initHarnessGit(harnessRoot: string): void {
  execFileSync("git", ["-C", harnessRoot, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  writeFileSync(path.join(harnessRoot, ".gitkeep"), "");
  execFileSync("git", ["-C", harnessRoot, "add", "--", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], { stdio: "ignore" });
}

function configureTestIdentity(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  const configPath = path.join(harnessRoot, "harness.yaml");
  const config = readFileSync(configPath, "utf8");
  writeFileSync(configPath, config.includes("  identity:\n")
    ? config.replace("  identity:\n", "  identity:\n    personId: person_test\n    displayName: Harness Test\n")
    : config.replace(
      /^settings:$/mu,
      "settings:\n  identity:\n    personId: person_test\n    displayName: Harness Test"
    ), "utf8");
  execFileSync("git", ["-C", harnessRoot, "add", "harness.yaml"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-m", "test: configure identity"], { stdio: "ignore" });
}

function seedSoftwareCodingAssetHistory(rootDir: string): string {
  const relativeAssetRoot = "packages/cli/src/commands/extensions/assets/software-coding";
  cpSync(path.resolve(relativeAssetRoot), path.join(rootDir, relativeAssetRoot), { recursive: true });
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Harness Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "harness@example.test"]);
  execFileSync("git", ["-C", rootDir, "add", "--", relativeAssetRoot]);
  const commitDate = new Date(Date.now() - 60_000).toISOString();
  execFileSync("git", ["-C", rootDir, "-c", "commit.gpgsign=false", "commit", "-m", "seed software coding contract history"], {
    env: { ...process.env, GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate },
    stdio: "ignore"
  });
  return execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function gitStatus(harnessRoot: string): string {
  return execFileSync("git", ["-C", harnessRoot, "status", "--short"], { encoding: "utf8" }).trim();
}

function gitLog(harnessRoot: string): string {
  return execFileSync("git", ["-C", harnessRoot, "log", "--pretty=%B", "--all"], { encoding: "utf8" });
}
