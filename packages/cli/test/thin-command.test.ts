// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { daemonProtocolCommands, thinCliCommands } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { deriveCliCapabilities, parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";
import { emit, main, resolveCliVersion } from "../src/index.ts";

test("top-level help renders a derived domain directory and domain help filters commands", () => {
  const help = renderThinHelp();
  assert.equal(thinCliCommands.length, 135);
  for (const domain of [...new Set(daemonProtocolCommands.map((command) => command.path[0]))]
    .filter((value): value is string => value !== undefined)
    .sort())
    assert.match(help, new RegExp(`^  ${domain} \\(`, "mu"));
  assert.doesNotMatch(help, /ha task start <task-id>/u);
  const taskHelp = renderThinHelp([], "task");
  for (const command of thinCliCommands.filter(({ usage }) => usage.split(" ")[1] === "task"))
    assert.match(taskHelp, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(taskHelp, /ha decision propose|ha preset list/u);
  for (const domain of ["decision", "distill"]) {
    const domainHelp = renderThinHelp([], domain);
    for (const command of thinCliCommands.filter(({ usage }) => usage.split(" ")[1] === domain))
      assert.match(domainHelp, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  const scriptHelp = renderThinHelp([], "script"),
    factHelp = renderThinHelp([], "fact"),
    decisionHelp = renderThinHelp([], "decision");
  assert.match(scriptHelp, /ha script run .*--task <task>/u);
  assert.doesNotMatch(scriptHelp, /--task-id/u);
  assert.match(factHelp, /ha fact record \[task-id\].*--text <text>/u);
  assert.match(decisionHelp, /--json-input <json-input>[\s\S]*JSON required fields: title, question/u);
  assert.match(decisionHelp, /--json-input <json-input>[\s\S]*<json\|@->/u);
  assert.match(help, /capabilities \[--json\].*--version.*ha daemon start --service/su);
});

test("an unknown command domain reports unknown with the available set instead of an empty help page", async () => {
  const logs: string[] = [],
    errors: string[] = [],
    log = console.log,
    error = console.error;
  console.log = (value: unknown) => {
    logs.push(String(value));
  };
  console.error = (value: unknown) => {
    errors.push(String(value));
  };
  const exits: number[] = [];
  try {
    exits.push(await main(["bananas", "--help"]), await main(["bananas"]), await main(["migrate", "--help"]));
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.deepEqual(exits, [2, 2, 0]);
  assert.equal(errors.length, 2);
  assert.equal(errors[0], errors[1]);
  for (const line of errors) {
    assert.match(line, /code=unsupported_command/u);
    assert.match(line, /bananas is not a command domain/u);
    for (const domain of Object.keys(deriveCliCapabilities())) assert.match(line, new RegExp(`\\b${domain}\\b`, "u"));
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /Commands for migrate:\n {2}ha migrate import/u);
  assert.match(logs[0] ?? "", /ha migrate rekey-facts(?: --dry-run)?/u);
});

test("capabilities is an exact-set projection of the command contract", () => {
  assert.deepEqual(deriveCliCapabilities(), {
    agenda: ["agenda"],
    agent: ["agent-create", "agent-inspect", "agent-install", "agent-list", "agent-validate"],
    ci: ["ci-observe-pull"],
    daemon: [
      "daemon-fleet-center-start",
      "daemon-fleet-edge-sync",
      "daemon-projection-rebuild",
      "daemon-repo-register",
      "daemon-repo-unregister",
      "daemon-start",
      "daemon-status",
      "daemon-stop",
    ],
    decision: [
      "decision-accept",
      "decision-amend",
      "decision-claim-add",
      "decision-claim-fulfill",
      "decision-defer",
      "decision-list",
      "decision-propose",
      "decision-reckon",
      "decision-reject",
      "decision-relate",
      "decision-relation-replace",
      "decision-relation-retire",
      "decision-repin",
      "decision-retire",
      "decision-show",
      "decision-supersede",
      "decision-transition",
      "decision-validate",
      "decision-verify",
    ],
    distill: ["distill-candidate", "distill-promote"],
    doc: [
      "doc-conflict-discard-local",
      "doc-conflict-overwrite-center",
      "doc-conflict-resolve",
      "doc-materialize",
      "doc-retire",
      "doc-show",
      "doc-status",
      "doc-sync-dry-run",
      "doc-sync-submit",
    ],
    entity: ["entity-explain", "entity-get", "entity-list"],
    fact: ["fact-record", "fact-search", "fact-show"],
    init: ["repo-bootstrap"],
    migrate: ["fact-rekey", "ledger-migrate", "migrate-import"],
    preset: [
      "preset-audit",
      "preset-check",
      "preset-inspect",
      "preset-install",
      "preset-list",
      "preset-seed",
      "preset-uninstall",
      "preset-upgrade",
      "preset-validate",
    ],
    receipt: ["receipt-show"],
    relation: ["relation-list"],
    runtime: [
      "runtime-batch",
      "runtime-cancel",
      "runtime-instance-create",
      "runtime-instance-delete",
      "runtime-instance-github-credential-set",
      "runtime-instance-github-credential-unset",
      "runtime-instance-list",
      "runtime-instance-login",
      "runtime-instance-logout",
      "runtime-instance-show",
      "runtime-instance-update",
      "runtime-run",
      "runtime-status",
    ],
    schedule: [
      "schedule-create",
      "schedule-delete",
      "schedule-disable",
      "schedule-enable",
      "schedule-list",
      "schedule-run-now",
      "schedule-show",
      "schedule-update",
    ],
    script: ["preset-run-start", "script-inspect", "script-list", "script-run"],
    settings: ["settings-read", "settings-update"],
    people: [
      "people-add",
      "people-bind",
      "people-delegate",
      "people-remove",
      "people-revoke-delegation",
      "people-set-role",
    ],
    squad: ["squad-inspect", "squad-install", "squad-list", "squad-run", "squad-status", "squad-validate"],
    task: [
      "task-amend",
      "task-archive",
      "task-artifact-add",
      "task-closeout",
      "task-code-doc-reconcile",
      "task-code-doc-repoint",
      "task-complete",
      "task-contract-migrate",
      "task-create",
      "task-declare-executor",
      "task-delete",
      "task-dispatches",
      "task-list",
      "task-pin",
      "task-progress-append",
      "task-relate",
      "task-release",
      "task-reopen",
      "task-review",
      "task-review-consent",
      "task-review-execution",
      "task-show",
      "task-start",
      "task-submit",
      "task-supersede",
      "task-transition",
      "task-unpin",
    ],
    template: ["template-list", "template-render"],
    vertical: ["vertical-validate"],
  });
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
          presetId: "standard-task",
          profileId: "baseline",
          outputShape: "repository-diff",
          completionGates: ["ci", "code-doc-reconciliation"],
          nextAction: "edit tasks/task-one/task_plan.md, then run ha task start task-one --execution-id <id>",
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
    inspect = parseThinCommand(["preset", "inspect", "standard-task", "--locale", "en-US"]),
    check = parseThinCommand(["preset", "check", "standard-task", "--snapshot-digest", `sha256:${"a".repeat(64)}`]),
    validate = parseThinCommand(["preset", "validate", "--source", "package"]),
    install = parseThinCommand(["preset", "install", "--source", "package", "--dry-run"]),
    seed = parseThinCommand(["preset", "seed", "--dry-run"]),
    audit = parseThinCommand(["preset", "audit", "--vertical", "software/coding"]),
    uninstall = parseThinCommand(["preset", "uninstall", "standard-task", "--dry-run"]),
    upgrade = parseThinCommand(["preset", "upgrade", "task-1"]);
  assert.equal(
    [create, inspect, check, validate, install, seed, audit, uninstall, upgrade].every((result) => result.ok),
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

test("thin parser routes CI observation pulls through the repo task command", () => {
  const parsed = parseThinCommand(["ci", "observe", "pull", "--limit", "20"]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) {
    assert.equal(parsed.command.method, "repo.task.run");
    assert.deepEqual(parsed.command.action, { kind: "ci-observe-pull", limit: 20 });
  }
  assert.equal(parseThinCommand(["ci", "observe", "pull", "--limit", "0"]).ok, false);
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
