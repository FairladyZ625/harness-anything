// harness-test-tier: integration
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandGroups } from "../src/cli/command-spec/command-groups.ts";
import { commandSpecs } from "../src/cli/command-spec/index.ts";
import { commandRegistry } from "../src/cli/command-registry.ts";
import { writeIndex } from "./helpers/local-lifecycle-fixtures.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("doctor reports read-only environment and harness diagnostics without writing local state", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["doctor"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "doctor");
    assert.equal(result.report.schema, "harness-doctor/v1");
    assert.equal(result.report.readOnly, true);
    assert.equal(result.report.node.requiredMajor, 24);
    assert.equal(typeof result.report.node.ok, "boolean");
    assert.equal(result.report.harness.authoredRoot, "harness");
    assert.equal(result.report.harness.authoredRootExists, false);
    assert.equal(result.report.harness.authoredRootGitExists, false);
    assert.equal(result.report.harness.isolation.ok, true);
    assert.equal(result.report.harness.localRootExists, false);
    assert.equal(result.report.recommendedCommands.includes("harness-anything check --post-merge --json"), true);
    assert.equal(result.report.recommendedCommands.includes("harness-anything doctor --repair --json"), false);
    assert.equal(result.report.settings.rows.length, 23);
    assert.equal(result.report.settings.rows.every((row: Record<string, unknown>) => row.source === "default"), true);
    assert.equal(result.report.settings.rows.find((row: Record<string, unknown>) => row.key === "gui.rendererUrl")?.value, null);
    assert.equal(JSON.stringify(result).includes(rootDir), false);
    assert.equal(existsSync(path.join(rootDir, ".harness")), false);
  });
});

test("doctor rejects unknown local flags instead of silently ignoring them", () => {
  withTempRoot((rootDir) => {
    const child = spawnSync(process.execPath, [cliEntry, "--root", rootDir, "--json", "doctor", "--bogus"], {
      encoding: "utf8",
      env: cliTestEnv({ HARNESS_ACTOR: "agent:doctor-test" })
    });

    assert.equal(child.status, 2, child.stdout);
    const receipt = JSON.parse(child.stdout) as Record<string, any>;
    assert.equal(receipt.ok, false, child.stdout);
    assert.equal(receipt.error.code, "unknown_option");
    assert.match(receipt.error.hint, /Unknown option '--bogus' for 'doctor'/u);
  });
});

test("doctor retains a ledger report when settings resolution fails", () => {
  withTempRoot((rootDir) => {
    const child = spawnSync(process.execPath, [cliEntry, "--root", rootDir, "--json", "doctor"], {
      encoding: "utf8",
      env: cliTestEnv({
        HARNESS_ACTOR: "agent:doctor-test",
        HARNESS_TASK_LEASE_TTL_MS: "not-an-integer"
      })
    });

    assert.equal(child.status, 1, child.stdout);
    const receipt = JSON.parse(child.stdout) as Record<string, any>;
    assert.equal(receipt.ok, false, child.stdout);
    assert.equal(receipt.error.code, "harness_settings_invalid");
    const report = receipt.details?.data?.report as Record<string, any>;
    assert.ok(report, child.stdout);
    assert.equal(report.ledger.checked, false);
    assert.equal(report.ledger.ok, true);
    assert.equal(report.settings.rows.length, 0);
    assert.match(report.settings.error, /HARNESS_TASK_LEASE_TTL_MS/u);
  });
});

test("doctor resolves landed settings values and source layers without writing", () => {
  withTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
      "schema: harness-anything/v1",
      "settings:",
      "  tasks:",
      "    leaseTtlMs: 7000",
      "  execution:",
      "    consentTtlMs: 8000",
      "  daemonRuntime:",
      "    materializerPollMs: 9000",
      ""
    ].join("\n"), "utf8");

    const result = runJson(rootDir, ["doctor"], {
      HARNESS_TASK_LEASE_TTL_MS: "7100",
      HARNESS_GIT_MAX_BUFFER_BYTES: "1048576",
      ELECTRON_RENDERER_URL: "http://127.0.0.1:5173/app"
    });
    const rows = new Map(result.report.settings.rows.map((row: Record<string, unknown>) => [row.key, row]));

    assert.deepEqual(pickResolved(rows.get("tasks.leaseTtlMs")), { value: 7100, source: "env" });
    assert.deepEqual(pickResolved(rows.get("execution.consentTtlMs")), { value: 8000, source: "yaml" });
    assert.deepEqual(pickResolved(rows.get("daemonRuntime.materializerPollMs")), { value: 9000, source: "yaml" });
    assert.deepEqual(pickResolved(rows.get("git.maxBufferBytes")), { value: 1_048_576, source: "env" });
    assert.deepEqual(pickResolved(rows.get("gui.rendererUrl")), { value: "http://127.0.0.1:5173/app", source: "env" });
    assert.equal(existsSync(path.join(rootDir, ".harness")), false);
  });
});

test("doctor sees initialized authored and generated harness roots without repairing them", () => {
  withTempRoot((rootDir) => {
    const initialized = runJson(rootDir, ["init"]);

    assert.deepEqual(initialized.report.isolation.nextSteps.slice(0, 3), [
      "ha daemon repo register --root .",
      "ha daemon start --service",
      "ha doctor --json"
    ]);

    const result = runJson(rootDir, ["doctor"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.harness.authoredRootExists, true);
    assert.equal(result.report.harness.authoredRootGitExists, true);
    assert.equal(result.report.harness.isolation.ok, true);
    assert.equal(result.report.harness.localRootExists, true);
    assert.equal(result.report.cli.command, "harness-anything doctor");
  });
});

test("doctor marks a misplaced declaration unhealthy even without an identity collision", () => {
  withTempRoot((rootDir) => {
    const taskId = "task_01KZ6MD2SMMHH91WC3RMRPV4P3";
    const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5";
    const slug = `${taskId}-misplaced`;
    writeIndex(rootDir, slug, "Misplaced declaration", "active", { taskId });
    const executionPath = path.join(rootDir, "harness/tasks", taskId, "executions", `${executionId}.md`);
    mkdirSync(path.dirname(executionPath), { recursive: true });
    writeFileSync(executionPath, `${JSON.stringify({
      schema: "execution/v2",
      execution_id: executionId,
      task_ref: `task/${taskId}`,
      state: "active",
      primary_actor: {
        principal: { personId: "person_fixture" },
        executor: { kind: "agent", id: "fixture" },
        responsibleHuman: "person_fixture"
      },
      claimed_at: "2026-08-05T00:00:00.000Z",
      submitted_at: null,
      closed_at: null,
      session_bindings: [],
      outputs: [],
      submission: null
    }, null, 2)}\n`, "utf8");

    const child = spawnSync(process.execPath, [cliEntry, "--root", rootDir, "--json", "doctor"], {
      encoding: "utf8",
      env: cliTestEnv({ HARNESS_ACTOR: "agent:doctor-test" })
    });
    assert.equal(child.status, 1, child.stdout);
    const receipt = JSON.parse(child.stdout) as Record<string, any>;
    const report = receipt.details?.data?.report as Record<string, any>;
    assert.equal(report.ledger.ok, false);
    assert.equal(report.ledger.declaredIdentity.conflictCount, 0);
    assert.equal(report.ledger.declaredIdentity.misplacedCount, 1);
    assert.equal(report.recommendedCommands.includes("harness-anything doctor --repair --json"), true);
  });
});

test("doctor reports existing harness that is not isolated from the outer git repository", () => {
  withTempRoot((rootDir) => {
    runGit(rootDir, "init", "--initial-branch=main");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
      "schema: harness-anything/v1",
      "name: unisolated",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      ""
    ].join("\n"), "utf8");

    const result = runJson(rootDir, ["doctor"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.harness.authoredRootExists, true);
    assert.equal(result.report.harness.authoredRootGitExists, false);
    assert.equal(result.report.harness.isolation.ok, false);
    assert.equal(result.report.harness.isolation.findings.some((finding: Record<string, unknown>) => finding.code === "harness_git_missing"), true);
    assert.equal(result.report.harness.isolation.findings.some((finding: Record<string, unknown>) => finding.code === "outer_gitignore_missing"), true);
    assert.equal(result.report.harness.isolation.nextSteps.includes("harness-anything init"), true);
  });
});

test("status command registry includes doctor", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);

    const result = runJson(rootDir, ["status"]);

    assert.equal(result.ok, true);
    const doctor = result.commands.find((entry: Record<string, unknown>) => entry.kind === "doctor");
    assert.equal(doctor?.primary, "harness-anything doctor [--repair] --json");
    assert.equal(doctor?.aliases.includes("ha doctor [--repair] --json"), true);
  });
});

test("CLI global help matches the layered discovery snapshot", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--help"], {
      encoding: "utf8"
    });

    assert.equal(stdout, readSnapshot("global-help.txt"));
    assert.equal(Buffer.byteLength(stdout) <= 2_500, true, "global help must remain at or below 2.5 KB");
  });
});

test("CLI global help groups exactly cover every top-level command kind plus daemon", () => {
  const registryKinds = new Set(commandRegistry.flatMap((entry) => entry.commandPath[0] ? [entry.commandPath[0]] : []));
  const expected = [...registryKinds, "daemon"].sort();
  assert.deepEqual(commandGroups.map((group) => group.name).sort(), expected);
});

test("CLI task help lists every task leaf and declares --json only as a global option", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "task", "--help"], {
      encoding: "utf8"
    });
    const renderedTaskLeaves = stdout.split("\n").filter((line) => line.startsWith("  harness-anything task "));
    const expectedDefaultTaskLeaves = commandRegistry
      .filter((entry) => entry.commandPath[0] === "task")
      .filter((entry) => displayForCommand(entry.kind) === "default")
      .map((entry) => `  ${entry.primary.replace(/ \[--json\]/gu, "").replace(/ --json$/u, "")} - ${entry.summary}`);
    const expectedAdvancedTaskLeaves = commandRegistry
      .filter((entry) => entry.commandPath[0] === "task")
      .filter((entry) => displayForCommand(entry.kind) === "advanced")
      .map((entry) => `  ${entry.primary.replace(/ \[--json\]/gu, "").replace(/ --json$/u, "")} - ${entry.summary}`);

    assert.deepEqual(renderedTaskLeaves, [...expectedDefaultTaskLeaves, ...expectedAdvancedTaskLeaves]);
    assert.match(stdout, /Primary workflow:[\s\S]+1\. ha task create[\s\S]+2\. ha task start[\s\S]+3\. ha task progress append[\s\S]+4\. ha fact record[\s\S]+5\. ha task submit[\s\S]+6\. ha task code-doc reconcile[\s\S]+7\. ha task complete/u);
    assert.match(stdout, /Advanced commands:[\s\S]+task claim[\s\S]+Deprecated compatibility spelling/u);
    assert.equal(stdout.match(/--json(?!-input)/gu)?.length, 1);
  });
});

test("CLI noun help exposes a bounded primary workflow and common/advanced tiers", () => {
  withTempRoot((rootDir) => {
    const nestedNouns = new Set(commandRegistry
      .filter((entry) => entry.commandPath.length > 1)
      .map((entry) => entry.commandPath[0]!));

    for (const noun of nestedNouns) {
      const group = commandGroups.find((candidate) => candidate.name === noun);
      assert.notEqual(group, undefined, noun);
      assert.equal((group?.primaryWorkflow?.length ?? 0) >= 1, true, noun);
      assert.equal((group?.primaryWorkflow?.length ?? 0) <= 7, true, noun);

      const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, noun, "--help"], {
        encoding: "utf8"
      });
      assert.match(stdout, /Primary workflow:/u, noun);
      assert.match(stdout, /Common commands:/u, noun);

      const advanced = commandSpecs.filter((entry) =>
        commandRegistry.find((candidate) => candidate.kind === entry.kind)?.commandPath[0] === noun
          && "display" in entry
          && entry.display === "advanced"
      );
      if (advanced.length > 0) assert.match(stdout, /Advanced commands:/u, noun);
    }
  });
});

test("CLI primary task leaf help links the workflow and explains schema-derived packets", () => {
  withTempRoot((rootDir) => {
    const create = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "task", "create", "--help"], { encoding: "utf8" });
    const start = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "task", "start", "--help"], { encoding: "utf8" });
    const progress = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "task", "progress", "append", "--help"], { encoding: "utf8" });
    const submit = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "task", "submit", "--help"], { encoding: "utf8" });
    const complete = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "task", "complete", "--help"], { encoding: "utf8" });

    assert.match(create, /Next:\s+ha task start <task-id>/u);
    assert.match(start, /Next:\s+ha task progress append <task-id>/u);
    assert.match(progress, /Next:\s+ha fact record --task <task-id> --statement "<verified fact>"/u);
    assert.match(submit, /Packet schema: harness:\/\/schema\/cli\/task-submit-input\/v1/u);
    assert.match(submit, /Packet template \(copy as submission\.json\):[\s\S]+"completionClaim"[\s\S]+"residualRisks"/u);
    assert.match(submit, /Required Holder order:[\s\S]+task start[\s\S]+task submit[\s\S]+releases it[\s\S]+task complete --help/u);
    assert.match(complete, /Packet schema: harness:\/\/schema\/cli\/task-complete-input\/v1/u);
    assert.match(complete, /Provide exactly one consent source: consentId, consentUtterance, consentStandingPolicyDecisionId, consentAssertedRationale/u);
    assert.match(complete, /Packet template \(copy as approval\.json\):[\s\S]+"findings"[\s\S]+"consentActions"/u);
    assert.match(complete, /Required sequence for --approve --from-file[\s\S]+task code-doc reconcile[\s\S]+task complete/u);
    assert.match(complete, /Required sequence for --commit-anchor:[\s\S]+do not add --path or --pr/iu);
    assert.match(complete, /Next:\s+ha task show <task-id> --view trace/u);
  });
});

test("task delete help exposes production soft delete and hard-delete alternatives", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "task", "delete", "--help"], {
      encoding: "utf8"
    });

    assert.match(stdout, /production does not offer hard delete/iu);
    assert.match(stdout, /task archive or task supersede/iu);
    assert.match(stdout, /--soft <id>/u);
  });
});

test("init text receipt gives the daemon registration and startup path", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "init"], {
      encoding: "utf8"
    });

    assert.match(stdout, /Next: ha daemon repo register --root \.; then ha daemon start --service; verify with ha doctor --json\./u);
  });
});

test("CLI capabilities exposes daemon onboarding operations", () => {
  withTempRoot((rootDir) => {
    const index = runJson(rootDir, ["capabilities"]);
    const daemon = runJson(rootDir, ["capabilities", "--kind", "daemon"]);

    assert.equal(index.report.items.some((item: Record<string, unknown>) => item.kind === "daemon"), true);
    assert.deepEqual(daemon.report.ops.map((operation: Record<string, unknown>) => operation.action), [
      "register",
      "start",
      "status",
      "logs",
      "stop",
      "restart",
      "refresh",
      "upgrade"
    ]);
    assert.equal(daemon.report.ops[0]?.command, "ha daemon repo register --root .");
  });
});

test("command-level help exits without creating task state", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "task", "create", "--help"], {
      encoding: "utf8"
    });

    assert.match(stdout, /Usage: harness-anything task create --title <title>/u);
    assert.match(stdout, /Aliases:/u);
    assert.doesNotMatch(stdout, /new-task --title <title> \(deprecated/u);
    assert.equal(stdout.match(/--json(?!-input)/gu)?.length, 1);
    assert.match(stdout, /Options:/u);
    assert.match(stdout, /--title/u);
    assert.match(stdout, /Recommended presets:/u);
    assert.match(stdout, /standard-task\s+General implementation or maintenance task; the default starting point\./u);
    assert.match(stdout, /decision-conformance\s+Work that must prove alignment with recorded decisions\./u);
    assert.match(stdout, /milestone-closeout\s+Milestone wrap-up checks and evidence collection\./u);
    assert.match(stdout, /ha task create --title "\.\.\." --vertical software\/coding --preset <id>/u);
    assert.equal(existsSync(path.join(rootDir, "harness")), false);
    assert.equal(existsSync(path.join(rootDir, ".harness")), false);
  });
});

test("migration help marks only the accepted sunset commands deprecated", () => {
  withTempRoot((rootDir) => {
    const migration = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "migrate", "--help"], { encoding: "utf8" });

    assert.match(migration, /migrate plan.*Deprecated — sunset stage 1\/3/u);
    assert.match(migration, /migrate retired-attribution-fields.*Deprecated — sunset stage 1\/3/u);
    assert.doesNotMatch(migration, /migrate fact-execution.*Deprecated/u);
  });
});

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doctor-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function displayForCommand(kind: string): "default" | "advanced" | "hidden" {
  const spec = commandSpecs.find((entry) => entry.kind === kind);
  return spec && "display" in spec ? spec.display : "default";
}

function runGit(rootDir: string, ...args: string[]): void {
  execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness-test@example.invalid",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness-test@example.invalid"
    }
  });
}

function runJson(rootDir: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: cliTestEnv({
      HARNESS_ACTOR: "agent:doctor-test",
      HARNESS_GIT_AUTHOR_NAME: "Harness Test",
      HARNESS_GIT_AUTHOR_EMAIL: "harness-test@example.invalid",
      ...env
    })
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

function pickResolved(row: Record<string, unknown> | undefined): { readonly value: unknown; readonly source: unknown } {
  return { value: row?.value, source: row?.source };
}

function readSnapshot(name: string): string {
  return readFileSync(path.resolve("packages/cli/test/snapshots", name), "utf8");
}
