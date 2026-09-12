// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { daemonProtocolCommands, thinCliCommands } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { taskCreateGuidance } from "../../daemon/src/receipt-guidance.ts";
import { deriveCliCapabilities, parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";
import { emit, main, resolveCliVersion } from "../src/index.ts";

test("doc conflict exits preserve the conflict id for daemon dispatch", () => {
  for (const action of ["resolve", "discard-local", "overwrite-center"] as const) {
    const parsed = parseThinCommand(["doc", "conflict", action, "abcdef12"]);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (parsed.ok)
      assert.deepEqual(parsed.command.action, {
        kind: `doc-conflict-${action}`,
        conflictId: "abcdef12",
      });
  }
});

test("CLI version is read from the CLI package metadata", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(resolveCliVersion(), packageJson.version);
});

test("task-create help renders recommended presets only from effective catalog rows", () => {
  const help = renderThinHelp([
    {
      id: "standard-task",
      title: "Standard Task",
      description: "General work.",
      validity: "valid",
      ...{
        defaultProfile: "baseline",
        outputShape: "repository-diff",
        completionGates: ["ci", "code-doc-reconciliation"],
      },
    },
    {
      id: "module",
      title: "Module",
      description: "Registered module work.",
      validity: "unavailable",
      errorCode: "missing_provider",
    },
  ]);
  assert.match(
    help,
    /Recommended presets:.*standard-task — Standard Task — General work\..*module — Module — unavailable \(missing_provider\)/su,
  );
  assert.match(
    help,
    /profile=baseline.*outputShape=repository-diff.*completionGates=\["ci","code-doc-reconciliation"\]/su,
  );
  assert.doesNotMatch(help, /reference-task|long-running-task/u);
});

test("human preset and task receipts print resolved completion contracts byte-for-byte", () => {
  const presetOutput = captureStdout(() =>
      emit(
        {
          ok: true,
          command: "preset-list",
          evidence: JSON.stringify([
            {
              id: "standard-task",
              title: "Standard Task",
              description: "General work.",
              validity: "valid",
              defaultProfile: "baseline",
              outputShape: "repository-diff",
              completionGates: ["ci", "code-doc-reconciliation"],
            },
          ]),
        },
        false,
      ),
    ),
    expectedPreset = [
      "standard-task — Standard Task — General work.",
      "  validity: valid",
      "  defaultProfile: baseline",
      "  outputShape: repository-diff",
      '  completionGates: ["ci","code-doc-reconciliation"]',
    ].join("\n");
  assert.deepEqual(Buffer.from(presetOutput), Buffer.from(expectedPreset));

  const taskOutput = captureStdout(() =>
      emit(
        {
          ok: true,
          command: "task-create",
          summary: "created task task-one at tasks/task-one",
          taskId: "task-one",
          packagePath: "tasks/task-one",
          presetId: "standard-task",
          profileId: "baseline",
          outputShape: "repository-diff",
          completionGates: ["ci", "code-doc-reconciliation"],
          dryRun: false,
          proof: { canonicalVisible: true },
          guidance: taskCreateGuidance({
            taskId: "task-one",
            packagePath: "tasks/task-one",
            outputShape: "repository-diff",
            dryRun: false,
            opId: "op-one",
            canonicalVisible: true,
          }),
        },
        false,
      ),
    ),
    expectedContract = [
      "contract: repository-diff requires a committable public-repository diff, ",
      "real CI, and a code-doc reconciliation witness. ",
      "For a task-package-only report or decision, use the task-package-artifact preset docs-task.",
    ].join(""),
    expectedTask = [
      "created task task-one at tasks/task-one",
      "preset: standard-task/baseline",
      "outputShape: repository-diff",
      'completionGates: ["ci","code-doc-reconciliation"]',
      expectedContract,
      "next: edit tasks/task-one/task_plan.md, then run ha task start task-one --execution-id <id>",
      "plan: write the concrete plan at harness/tasks/task-one/task_plan.md; required sections: Brief, Goal, " +
        "Context, Required Reading, Entry Conditions, Dependencies, Execution Surface, Constraints, Checkpoint, " +
        "CI/Gate Authority Stop Condition, Implementation Plan, Deliverable Contract, Evidence Protocol, " +
        "Verification",
      "agenda: use ha task pin task-one to pin it to the CEO agenda",
      "ledger: INDEX.md and closeout.md are coordinator-managed; update them through ha doc sync",
    ].join("\n");
  assert.deepEqual(Buffer.from(taskOutput), Buffer.from(expectedTask));

  const replayOutput = captureStdout(() =>
    emit(
      {
        ok: true,
        command: "task-create",
        summary: "reused task task-one for the supplied idempotency key",
      },
      false,
    ),
  );
  assert.equal(replayOutput, "reused task task-one for the supplied idempotency key");
});

test("thin parser derives closed preset and task-create payloads from descriptors", () => {
  assert.equal(parseThinCommand(["doc", "sync"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--title", "Bound", "--completion-gate", "G32"]).ok, false);
  const create = parseThinCommand([
      "task",
      "create",
      "--title",
      "Bound",
      "--preset",
      "create-milestone",
      "--task-class",
      "milestone",
      "--dry-run",
    ]),
    tree = parseThinCommand(["task", "list", "--parent", "task-root", "--depth", "all", "--search", "needle"]),
    inspect = parseThinCommand(["preset", "inspect", "standard-task", "--locale", "en-US"]),
    check = parseThinCommand(["preset", "check", "standard-task", "--snapshot-digest", `sha256:${"a".repeat(64)}`]),
    validate = parseThinCommand(["preset", "validate", "--source", "package"]),
    install = parseThinCommand(["preset", "install", "--source", "package", "--dry-run"]),
    seed = parseThinCommand(["preset", "seed", "--dry-run"]),
    audit = parseThinCommand(["preset", "audit", "--vertical", "software/coding"]),
    uninstall = parseThinCommand(["preset", "uninstall", "standard-task", "--dry-run"]),
    upgrade = parseThinCommand(["preset", "upgrade", "task-1"]);
  assert.equal(
    [create, tree, inspect, check, validate, install, seed, audit, uninstall, upgrade].every((result) => result.ok),
    true,
  );
  if (create.ok) {
    assert.equal(create.command.method, "repo.task.create");
    assert.deepEqual(create.command.action, {
      kind: "task-create",
      title: "Bound",
      presetId: "create-milestone",
      taskClass: "milestone",
      dryRun: true,
    });
  }
  if (tree.ok)
    assert.deepEqual(tree.command.action, {
      kind: "task-list",
      parentTaskId: "task-root",
      depth: "all",
      search: "needle",
    });
  if (inspect.ok) {
    assert.equal(inspect.command.method, "repo.preset.inspect");
    assert.deepEqual(inspect.command.action, {
      kind: "preset-inspect",
      presetId: "standard-task",
      locale: "en-US",
    });
  }
  if (check.ok) assert.equal(check.command.action.snapshotDigest, `sha256:${"a".repeat(64)}`);
  if (validate.ok)
    assert.deepEqual(validate.command.action, {
      kind: "preset-validate",
      packageSource: "package",
    });
  if (install.ok)
    assert.deepEqual(install.command.action, {
      kind: "preset-install",
      packageSource: "package",
      dryRun: true,
    });
  if (seed.ok)
    assert.deepEqual(seed.command.action, {
      kind: "preset-seed",
      dryRun: true,
    });
  if (audit.ok)
    assert.deepEqual(audit.command.action, {
      kind: "preset-audit",
      verticalId: "software/coding",
    });
  if (uninstall.ok)
    assert.deepEqual(uninstall.command.action, {
      kind: "preset-uninstall",
      presetId: "standard-task",
      dryRun: true,
    });
  if (upgrade.ok)
    assert.deepEqual(upgrade.command.action, {
      kind: "preset-upgrade",
      taskId: "task-1",
    });
});

test("runtime instance parser rejects repeated static headers regardless of spelling", () => {
  const base = [
    "runtime",
    "instance",
    "create",
    "--id",
    "codex-headers",
    "--name",
    "Codex Headers",
    "--kind",
    "codex",
    "--provider",
    "sidecar",
    "--model",
    "gpt-5.6-sol",
    "--auth",
    "api-key",
    "--credential-ref",
    "credential:v1:codex-headers",
  ];
  const accepted = parseThinCommand([...base, "--http-header", "X-Custom=static"]);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  if (accepted.ok) assert.deepEqual(accepted.command.action.codex, { httpHeaders: { "X-Custom": "static" } });
  const compatibility = parseThinCommand([
    ...base,
    "--base-url",
    "http://192.168.1.20:8080/v1",
    "--allow-insecure-http",
    "--credential-header",
    "x-api-key",
  ]);
  assert.equal(compatibility.ok, true, JSON.stringify(compatibility));
  if (compatibility.ok)
    assert.deepEqual(compatibility.command.action.codex, {
      baseUrl: "http://192.168.1.20:8080/v1",
      allowInsecureHttp: true,
      credentialHeader: "x-api-key",
    });
  for (const duplicate of [
    ["X-Custom=first", "X-Custom=second"],
    ["X-Custom=first", "x-custom=second"],
  ]) {
    const rejected = parseThinCommand([...base, ...duplicate.flatMap((value) => ["--http-header", value])]);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    if (!rejected.ok) {
      assert.equal(rejected.code, "invalid_field");
      assert.match(rejected.nextAction, /HTTP header .* was provided more than once\./u);
    }
  }
});

test("thin parser routes CI observation pulls through the repo task command", () => {
  const parsed = parseThinCommand(["ci", "observe", "pull", "--limit", "20"]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) {
    assert.equal(parsed.command.method, "repo.task.run");
    assert.deepEqual(parsed.command.action, { kind: "ci-observe-pull", limit: 20 });
  }
  assert.equal(parseThinCommand(["ci", "observe", "pull", "--limit", "0"]).ok, false);
  const named = parseThinCommand(["ci", "observe", "pull", "--run", "34091151001", "--run", "33890867571"]);
  assert.equal(named.ok, true, JSON.stringify(named));
  if (named.ok)
    assert.deepEqual(named.command.action, { kind: "ci-observe-pull", runs: ["34091151001", "33890867571"] });
  assert.equal(parseThinCommand(["ci", "observe", "pull", "--run", "abc"]).ok, false);
});

test("thin parser validates only the selected command descriptor", () => {
  const selected = daemonProtocolCommands.find((command) => command.id === "task-show");
  assert.ok(selected);
  const unrelatedInvalid = {
      ...selected,
      id: "unrelated-invalid",
      path: ["unrelated-invalid"],
      inputs: [{}],
      flags: [{}],
    } as unknown as typeof selected,
    parsed = parseThinCommand(["task", "show", "task-1"], process.cwd(), [
      selected,
      unrelatedInvalid,
    ] as unknown as typeof daemonProtocolCommands);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});

test("shared CLI option rejections point to descriptor-derived leaf help", () => {
  assert.deepEqual(parseThinCommand(["task", "create", "--policy-conformance-probe"]), {
    ok: false,
    code: "unknown_field",
    nextAction: "Unknown option --policy-conformance-probe. Run ha task create --help.",
    json: false,
  });
  assert.deepEqual(parseThinCommand(["task", "dispatches", "task-1", "--policy-conformance-probe"]), {
    ok: false,
    code: "unsupported_command",
    nextAction: "Run ha task dispatches --help.",
    json: false,
  });
  assert.deepEqual(parseThinCommand(["task", "show", "task-1", "--policy-conformance-probe"]), {
    ok: false,
    code: "unsupported_command",
    nextAction: "Run ha task show --help.",
    json: false,
  });
});

function captureStdout(run: () => void): string {
  const lines: string[] = [],
    log = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    run();
    return lines.join("\n");
  } finally {
    console.log = log;
  }
}
