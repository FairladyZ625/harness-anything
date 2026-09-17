// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { daemonServeEntry } from "../src/daemon/client.ts";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";

// The gh stub answers `run list`/`run view` from a response file the test rewrites between phases;
// every other invocation exits nonzero (a tolerated artifact-download failure or an outage).
const ciBin = mkdtempSync(path.join(tmpdir(), "ha-attest-override-gh-"));
let stubFile = "";
const originalPath = process.env.PATH;
before(() => {
  writeProviderExecutable(
    path.join(ciBin, "gh"),
    `const fs = require("node:fs");
const spec = JSON.parse(fs.readFileSync(process.env.GH_STUB_FILE, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "list") {
  if (spec.listError) process.exit(1);
  process.stdout.write(JSON.stringify(spec.list ?? []));
} else if (args[0] === "run" && args[1] === "view") {
  process.stdout.write(JSON.stringify(spec.view));
} else process.exit(1);
`,
  );
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

const cli = path.resolve("packages/cli/src/index.ts");

test("an owner break-glasses a gate with no automated receipt; a later receipt voids the waiver", async (context) => {
  const parent = mkdtempSync(path.join(privateTemporaryRoot(), "attest-override-live.")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "edge-user-root"),
    daemonId = `edge-attest-override-${process.pid}`,
    taskId = "task-attest-override-live",
    executionId = "execution-attest-override-live";
  stubFile = path.join(parent, "gh-stub.json");
  let daemon: ChildProcess | undefined;
  initialize(root);
  seedSettingsEvent({ rootDir: root, repoId: "attest-override-live" });
  writeFileSync(stubFile, JSON.stringify({ list: [] }));
  try {
    daemon = spawnBinDaemon(root, userRoot, daemonId);
    const status = waitForDaemon(root, userRoot, daemonId);
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(readDaemonPid(userRoot, daemonId), daemon.pid);
    assert.equal(
      run(root, userRoot, daemonId, ["daemon", "repo", "register", "--repo-id", "attest-override-live", "--root", root])
        .outcome,
      "applied",
    );
    const created = run(root, userRoot, daemonId, [
        "task",
        "create",
        "--id",
        taskId,
        "--admin",
        "--title",
        "Attest override live",
      ]),
      packagePath = String(created.packagePath);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    published(root, userRoot, daemonId, created);
    writeFileSync(path.join(root, "harness", `${packagePath}/task_plan.md`), realizedTaskPlan("Attest override live"));
    assert.equal(
      run(root, userRoot, daemonId, ["doc", "sync", "--submit", "--path", `${packagePath}/task_plan.md`]).outcome,
      "applied",
    );
    assert.equal(
      run(root, userRoot, daemonId, [
        "fact",
        "record",
        "--task",
        taskId,
        "--statement",
        "The gate collects no automated receipt while the runner is unreachable.",
        "--source",
        "test:attest-override-live",
      ]).outcome,
      "applied",
    );
    assert.equal(
      run(root, userRoot, daemonId, ["task", "start", taskId, "--execution-id", executionId]).outcome,
      "applied",
    );
    // The delivery cut diffs the public repo against the baseline frozen at task start.
    writeFileSync(path.join(root, "delivery.txt"), "delivered\n");
    git(root, "add", "delivery.txt");
    git(root, "commit", "--quiet", "-m", "test: delivery");
    const deliveredSha = git(root, "rev-parse", "HEAD");
    writeFileSync(
      path.join(root, "harness", `${packagePath}/closeout.md`),
      `# Closeout\n\n## Summary\n\nDelivered at ${deliveredSha}.\n\n## Verification\n\nLive daemon route.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nCovered by the witness contract.\n`,
    );
    assert.equal(run(root, userRoot, daemonId, ["doc", "sync", "--submit", "--task", taskId]).outcome, "applied");
    const submitted = run(root, userRoot, daemonId, ["task", "submit", taskId, "--execution-id", executionId]);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const shown = taskSnapshot(run(root, userRoot, daemonId, ["task", "show", taskId])),
      cutSha = shown.executions[0]?.submission?.commitSha;
    assert.equal(typeof cutSha, "string");

    // Phase A: no automated receipt exists. complete stops on the missing gate and offers the
    // owner's break-glass override; approve cannot sign off a gate that has no automated pass.
    const missing = runMaybe(root, userRoot, daemonId, ["task", "complete", taskId]);
    assert.equal(missing.status, 1, `${missing.stderr}\n${missing.stdout}`);
    const missingReceipt = JSON.parse(missing.stdout) as Record<string, unknown>;
    assert.equal(missingReceipt.outcome, "op_rejected");
    assert.match(
      JSON.stringify(missingReceipt.next),
      /ha task attest .* --gate ci --result pass --mode override --rationale/u,
    );
    const prematureApprove = runMaybe(root, userRoot, daemonId, [
      "task",
      "attest",
      taskId,
      "--gate",
      "ci",
      "--result",
      "pass",
    ]);
    assert.equal(JSON.parse(prematureApprove.stdout).code, "invalid_transition");
    // A runtime-shaped caller never attests, whatever mode it asks for.
    const asExecutor = runMaybe(
      root,
      userRoot,
      daemonId,
      [
        "task",
        "attest",
        taskId,
        "--gate",
        "ci",
        "--result",
        "pass",
        "--mode",
        "override",
        "--rationale",
        "runner lost",
      ],
      "agent:worker",
    );
    assert.equal(JSON.parse(asExecutor.stdout).code, "actor_unauthorized");
    // The ungoverned code-doc gate admits no override at all.
    const ungoverned = runMaybe(root, userRoot, daemonId, [
      "task",
      "attest",
      taskId,
      "--gate",
      "code-doc-reconciliation",
      "--result",
      "pass",
      "--mode",
      "override",
      "--rationale",
      "runner lost",
    ]);
    assert.equal(JSON.parse(ungoverned.stdout).code, "invalid_command");

    const waived = run(root, userRoot, daemonId, [
      "task",
      "attest",
      taskId,
      "--gate",
      "ci",
      "--result",
      "pass",
      "--mode",
      "override",
      "--rationale",
      "CI runner host was unreachable during the window",
    ]);
    assert.equal(waived.outcome, "applied", JSON.stringify(waived));
    published(root, userRoot, daemonId, waived);
    const afterWaiver = taskSnapshot(run(root, userRoot, daemonId, ["task", "show", taskId])),
      waiver = afterWaiver.gateWitnesses.find((witness) => witness.gateId === "ci" && witness.evidence.override);
    assert.equal(waiver?.evidence.override?.waivedReceiptId, null);
    assert.equal(waiver?.evidence.provenance?.source, "human");
    // The null waiver satisfies the gate judgment (readback above); do not run complete here —
    // a waived gate lets completion settle, and the voiding proof below needs a live execution.

    // Phase B: a completed red run lands; the new automated receipt voids the null waiver.
    writeFileSync(
      stubFile,
      JSON.stringify({
        list: [
          {
            databaseId: 7,
            headBranch: "main",
            headSha: cutSha,
            createdAt: "2026-09-17T00:00:00.000Z",
            status: "completed",
            conclusion: "failure",
          },
        ],
        view: {
          workflowName: "rewrite-ci",
          headSha: cutSha,
          headBranch: "main",
          status: "completed",
          conclusion: "failure",
          attempt: 1,
          event: "push",
        },
      }),
    );
    const pulled = run(root, userRoot, daemonId, ["ci", "observe", "pull"]);
    assert.equal(pulled.outcome, "applied", JSON.stringify(pulled));
    assert.match(String(pulled.evidence), /"imported":1/u, `red run must import once: ${pulled.evidence}`);
    const redComplete = runMaybe(root, userRoot, daemonId, ["task", "complete", taskId]);
    const redReceipt = JSON.parse(redComplete.stdout) as Record<string, unknown>;
    const redWitnesses = taskSnapshot(run(root, userRoot, daemonId, ["task", "show", taskId])).gateWitnesses;
    assert.equal(redReceipt.stoppedAt, "ci_missing", `${redComplete.stdout}\n${JSON.stringify(redWitnesses)}`);
    const afterRed = taskSnapshot(run(root, userRoot, daemonId, ["task", "show", taskId]));
    // The recorded fail stays canonical next to the human waiver; nothing is erased.
    assert.ok(
      afterRed.gateWitnesses.some((witness) => witness.gateId === "ci" && witness.result === "fail"),
      JSON.stringify(afterRed.gateWitnesses),
    );
    assert.ok(
      afterRed.gateWitnesses.some(
        (witness) => witness.gateId === "ci" && witness.evidence.override?.waivedReceiptId === null,
      ),
    );

    // The owner waives the recorded fail by its receipt.
    const waivedAgain = run(root, userRoot, daemonId, [
      "task",
      "attest",
      taskId,
      "--gate",
      "ci",
      "--result",
      "pass",
      "--mode",
      "override",
      "--rationale",
      "Failure is a known runner flake on this cut",
    ]);
    assert.equal(waivedAgain.outcome, "applied", JSON.stringify(waivedAgain));
    published(root, userRoot, daemonId, waivedAgain);
    const afterReWaiver = taskSnapshot(run(root, userRoot, daemonId, ["task", "show", taskId]));
    assert.ok(
      afterReWaiver.gateWitnesses.some(
        (witness) =>
          witness.gateId === "ci" &&
          typeof witness.evidence.override?.waivedReceiptId === "string" &&
          witness.evidence.override.waivedReceiptId.length > 0,
      ),
    );

    // Phase C: a green run lands; the pass voids the waiver and mandatorySignoff demands a plain
    // approve — the earlier override never counts as the signoff.
    writeFileSync(
      stubFile,
      JSON.stringify({
        list: [
          {
            databaseId: 8,
            headBranch: "main",
            headSha: cutSha,
            createdAt: "2026-09-17T00:01:00.000Z",
            status: "completed",
            conclusion: "success",
          },
        ],
        view: {
          workflowName: "rewrite-ci",
          headSha: cutSha,
          headBranch: "main",
          status: "completed",
          conclusion: "success",
          attempt: 1,
          event: "push",
        },
      }),
    );
    assert.equal(run(root, userRoot, daemonId, ["ci", "observe", "pull"]).outcome, "applied");
    const greenComplete = runMaybe(root, userRoot, daemonId, ["task", "complete", taskId]),
      greenReceipt = JSON.parse(greenComplete.stdout) as Record<string, unknown>;
    assert.equal(greenReceipt.stoppedAt, "ci_missing", greenComplete.stdout);
    assert.match(
      JSON.stringify(greenReceipt.next),
      /"action":"ha task attest .* --gate ci --result pass"/u,
      "the blocker must ask for a plain signoff, not another override",
    );
    const signoff = run(root, userRoot, daemonId, [
      "task",
      "attest",
      taskId,
      "--gate",
      "ci",
      "--result",
      "pass",
      "--note",
      "reviewed the green run",
    ]);
    assert.equal(signoff.outcome, "applied", JSON.stringify(signoff));
    published(root, userRoot, daemonId, signoff);
    const final = runMaybe(root, userRoot, daemonId, ["task", "complete", taskId]);
    assert.notEqual(JSON.parse(final.stdout).stoppedAt, "ci_missing", final.stdout);
    context.diagnostic(
      `attest-override-live=${JSON.stringify({
        daemonId,
        nullWaiver: waiver?.receiptId,
        phases: ["missing->waived(null)", "new fail->failed", "waived(receipt)", "new pass->signoff", "approved"],
      })}`,
    );

    const stopped = run(root, userRoot, daemonId, ["daemon", "stop", "--user-root", userRoot, "--daemon-id", daemonId]);
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    await childExit(daemon);
    daemon = undefined;
  } finally {
    if (readDaemonPid(userRoot, daemonId) !== null)
      runMaybe(root, userRoot, daemonId, ["daemon", "stop", "--user-root", userRoot, "--daemon-id", daemonId]);
    if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
    if (daemon) await childExit(daemon);
    rmSync(parent, { recursive: true, force: true });
  }
  assert.equal(existsSync(userRoot), false, "the dedicated daemon user-root must be removed after the live probe");
});

function privateTemporaryRoot(): string {
  const preferred = "/private/tmp";
  try {
    mkdirSync(preferred, { recursive: true });
    accessSync(preferred, constants.W_OK);
    return preferred;
  } catch {
    return tmpdir();
  }
}

function initialize(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  // ci is dual-control + overridable; the internal code-doc gate is mapped out of this fixture.
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    `layout:
  authoredRoot: harness
settings:
  ci:
    workflows: [rewrite-ci]
  gates:
    ci:
      appliesTo: code
      adapter: github-actions
      branch: main
      event: push
      coverage: descendant
      selection: newest
      mandatorySignoff: true
      allowOverride: true
    code-doc-reconciliation:
      adapter: none
`,
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `schema: harness-people/v1
people:
  - personId: owner
    displayName: Owner
    primaryEmail: owner@example.test
    roles: [owner]
    credentials:
      - kind: unix-socket-owner-boundary
        issuer: host:${hostname()}
        subject: ${process.getuid?.() ?? 0}
roles:
  - roleId: owner
    commandClasses: [admin, repo-write, repo-read, arbiter]
`,
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Attest Override Live Test");
  git(root, "config", "user.email", "attest-override-live@example.test");
  git(root, "add", "README.md", "harness");
  git(root, "commit", "--quiet", "-m", "fixture");
}

type WitnessRow = {
  readonly gateId: string;
  readonly result: string;
  readonly receiptId: string;
  readonly evidence: {
    readonly kind: string;
    readonly override?: { readonly rationale: string; readonly waivedReceiptId: string | null };
    readonly provenance?: { readonly source: string };
  };
};
type TaskSnapshot = {
  readonly executions: readonly {
    readonly submission: { readonly commitSha: string | null } | null;
  }[];
  readonly gateWitnesses: readonly WitnessRow[];
};

function spawnBinDaemon(root: string, userRoot: string, daemonId: string): ChildProcess {
  return spawn(
    process.execPath,
    [daemonServeEntry(), "serve", "--user-root", userRoot, "--daemon-id", daemonId, "--json"],
    {
      cwd: root,
      env: environment(root, userRoot, daemonId),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function waitForDaemon(root: string, userRoot: string, daemonId: string): Record<string, unknown> {
  let last = runMaybe(root, userRoot, daemonId, ["daemon", "status", "--user-root", userRoot, "--daemon-id", daemonId]);
  for (let attempt = 0; attempt < 300 && last.status !== 0; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    last = runMaybe(root, userRoot, daemonId, ["daemon", "status", "--user-root", userRoot, "--daemon-id", daemonId]);
  }
  assert.equal(last.status, 0, `${last.stderr}\n${last.stdout}`);
  return JSON.parse(last.stdout) as Record<string, unknown>;
}

function run(
  root: string,
  userRoot: string,
  daemonId: string,
  args: readonly string[],
  actor?: string,
): Record<string, unknown> {
  const result = runMaybe(root, userRoot, daemonId, args, actor);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// Writes return at durable acceptance; a test that reads Git or the worktree waits for both followers explicitly.
function published(root: string, userRoot: string, daemonId: string, receipt: Record<string, unknown>) {
  const wait = ["--wait", "git_verified,worktree_visible", "--timeout-ms", "5000"];
  return run(root, userRoot, daemonId, ["receipt", "show", String(receipt.opId), ...wait]);
}

function runMaybe(
  root: string,
  userRoot: string,
  daemonId: string,
  args: readonly string[],
  actor?: string,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: environment(root, userRoot, daemonId, actor),
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function environment(root: string, userRoot: string, daemonId: string, actor?: string): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repo,
    HARNESS_DAEMON_ID: _daemon,
    ...base
  } = process.env;
  return {
    ...base,
    HOME: path.join(root, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: daemonId,
    GH_STUB_FILE: stubFile,
    ...(actor ? { HARNESS_ACTOR: actor } : {}),
  };
}

function taskSnapshot(receipt: Record<string, unknown>): TaskSnapshot {
  return JSON.parse(String(receipt.evidence)) as TaskSnapshot;
}

function childExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("close", () => resolve());
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
