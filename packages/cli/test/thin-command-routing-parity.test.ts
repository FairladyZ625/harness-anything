// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DAEMON_RPC_SCHEMA,
  daemonMethodAcceptsPayloadExecutor,
  daemonProtocolCommands,
  thinCliCommands,
  validateDaemonRpcCall,
} from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { unknownFieldViolation } from "../../daemon/src/protocol/json-rpc-types.ts";
import { taskCreateGuidance } from "../../daemon/src/receipt-guidance.ts";
import { resolveHarnessLayout } from "../../kernel/src/index.ts";
import { workspacePathFormat } from "../../preset/src/preset-command-contract.ts";
import { cliCapabilities, deriveThinCliInputs, parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import { emit, main, resolveCliVersion } from "../src/index.ts";

test("top-level help renders a derived domain directory and domain help filters commands", () => {
  const help = renderThinHelp();
  assert.equal(
    thinCliCommands.length,
    daemonProtocolCommands.filter((command) => !("internal" in command && command.internal)).length,
  );
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
  assert.match(
    decisionHelp,
    /JSON defaulted fields: vertical \(repository defaultVertical\), preset \(decision-conformance\)/u,
  );
  assert.match(decisionHelp, /--json-input <json-input>[\s\S]*<json\|@->/u);
  const reviewHelp = renderThinHelp([], "task", "ha task review-execution");
  assert.match(reviewHelp, /^Command ha task review-execution:/mu);
  assert.match(reviewHelp, /JSON required fields: verdict, reason, evidenceChecked/u);
  assert.match(reviewHelp, /JSON values: verdict: approved\|changes_requested\|dismissed/u);
  assert.doesNotMatch(reviewHelp, /ha task (?:start|submit|complete) /u);
  const positionalHelp = renderThinHelp([], "task", "ha task review-execution task_x");
  assert.match(positionalHelp, /^Command ha task review-execution:/mu);
  assert.match(positionalHelp, /JSON required fields: verdict, reason, evidenceChecked/u);
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
    for (const domain of Object.keys(cliCapabilities)) assert.match(line, new RegExp(`\\b${domain}\\b`, "u"));
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /Commands for migrate:\n {2}ha migrate import/u);
  assert.match(logs[0] ?? "", /migrate ledger/u);
});

test("settings update projects repeatable CI workflow flags into the daemon Action", () => {
  const parsed = parseThinCommand(["settings", "update", "--ci-workflows", "ci", "--ci-workflows", "nightly"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.command.action, { kind: "settings-update", ciWorkflows: ["ci", "nightly"] });
  // .yml suffixes pass the identifier regex here and are rejected by the kernel compiler.
  const rejected = parseThinCommand(["settings", "update", "--ci-workflows", "bad name"]);
  assert.equal(rejected.ok, false);
});

test("repo lifecycle commands validate cache and destructive purge inputs", () => {
  const backup = path.join(tmpdir(), `ha-purge-all-${process.pid}-${Date.now()}`);
  const unbind = parseThinCommand(["repo", "unbind", "canonical"]),
    purge = parseThinCommand(["repo", "purge", "canonical", "--scope", "cache"]),
    purgeAll = parseThinCommand([
      "repo",
      "purge",
      "canonical",
      "--scope",
      "all",
      "--backup",
      backup,
      "--confirm",
      "canonical",
    ]);
  assert.equal(unbind.ok, true);
  assert.equal(purge.ok, true);
  assert.equal(purgeAll.ok, true);
  if (!unbind.ok || !purge.ok || !purgeAll.ok) return;
  assert.deepEqual(unbind.command.action, { kind: "repo-unbind", repoId: "canonical" });
  assert.equal(unbind.command.method, "daemon.repo.unbind");
  assert.deepEqual(purge.command.action, { kind: "repo-purge", repoId: "canonical", scope: "cache" });
  assert.deepEqual(purgeAll.command.action, {
    kind: "repo-purge",
    repoId: "canonical",
    scope: "all",
    backup,
    confirm: "canonical",
  });
  assert.equal(purge.command.method, "daemon.repo.purge");
  assert.equal(parseThinCommand(["repo", "unbind"]).ok, false);
  assert.equal(parseThinCommand(["repo", "unbind", "canonical", "extra"]).ok, false);
  assert.equal(parseThinCommand(["repo", "purge", "canonical", "--scope", "all"]).ok, false);
  assert.equal(
    parseThinCommand(["repo", "purge", "canonical", "--scope", "all", "--backup", "relative", "--confirm", "canonical"])
      .ok,
    false,
  );
  assert.equal(
    parseThinCommand(["repo", "purge", "canonical", "--scope", "all", "--backup", backup, "--confirm", "wrong"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["repo", "purge", "canonical", "--scope", "cache", "--backup", backup]).ok, false);
});

test("backup and restore drill preserve their positional daemon routes", () => {
  const backup = parseThinCommand(["backup", "/tmp/backup"]),
    drill = parseThinCommand(["restore", "--drill", "/tmp/backup", "--shadow-parent", "/tmp/drills"]);
  assert.equal(backup.ok, true);
  assert.equal(drill.ok, true);
  if (!backup.ok || !drill.ok) return;
  assert.equal(backup.command.method, "daemon.repo.backup");
  assert.deepEqual(backup.command.action, { kind: "ledger-backup", backupDir: "/tmp/backup" });
  assert.equal(drill.command.method, "daemon.repo.restoreDrill");
  assert.deepEqual(drill.command.action, {
    kind: "ledger-restore-drill",
    backupDir: "/tmp/backup",
    shadowParent: "/tmp/drills",
  });
});

test("entity import and update carry declared attributes as one typed JSON object", () => {
  const imported = parseThinCommand([
    "entity",
    "import",
    "--kind",
    "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16",
    "--locator",
    "surveys/north",
    "--expected-version",
    "0",
    "--attributes",
    '{"region":"north","fiscalYear":2026}',
  ]);
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  // The Kind declares its own attribute names at runtime, so the CLI cannot enumerate them as flags; JSON is
  // also the only form in which a number stated by the caller is still a number when the schema judges it.
  assert.deepEqual(imported.command.action, {
    kind: "entity-import",
    entityKind: "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16",
    locator: "surveys/north",
    expectedVersion: 0,
    attributes: { region: "north", fiscalYear: 2026 },
  });

  const updated = parseThinCommand([
    "entity",
    "update",
    "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16",
    "--id",
    "SRV-0a826f22e9c85d8b0a826f22e9c85d8b",
    "--expected-version",
    "1",
    "--attributes",
    '{"region":"south"}',
  ]);
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.deepEqual((updated.command.action as { readonly attributes: unknown }).attributes, { region: "south" });
});

test("agent and squad delete project their reason and expected version into the daemon Action", () => {
  for (const [noun, idField] of [
    ["agent", "agentId"],
    ["squad", "squadId"],
  ] as const) {
    const parsed = parseThinCommand([noun, "delete", "worker-a", "--reason", "retired", "--expected-version", "3"]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.command.action, {
      kind: `${noun}-delete`,
      [idField]: "worker-a",
      reason: "retired",
      expectedVersion: 3,
    });
  }
});

test("entity import projects its concurrency and dry-run flags into one daemon Action", () => {
  const parsed = parseThinCommand([
    "entity",
    "import",
    "--kind",
    "software/coding/architecture-decision-record@1",
    "--locator",
    "harness/adr/0001.md",
    "--expected-version",
    "0",
    "--dry-run",
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "repo.task.run");
  assert.deepEqual(parsed.command.action, {
    kind: "entity-import",
    entityKind: "software/coding/architecture-decision-record@1",
    locator: "harness/adr/0001.md",
    expectedVersion: 0,
    dryRun: true,
  });
  assert.equal(
    parseThinCommand([
      "entity",
      "import",
      "--kind",
      "software/coding/architecture-decision-record@1",
      "--locator",
      "moved.md",
      "--expected-version",
      "1",
      "--source-identity",
      "repo:canonical:old.md",
    ]).ok,
    false,
  );
});

test("entity update and archive preserve the entity revision fence", () => {
  const update = parseThinCommand([
    "entity",
    "update",
    "software/coding/architecture-decision-record@1",
    "--id",
    "ADR-abc",
    "--title",
    "Revised",
    "--locator",
    "docs/revised.md",
    "--content-version",
    "git:abc",
    "--expected-version",
    "7",
  ]);
  assert.equal(update.ok, true);
  if (update.ok)
    assert.deepEqual(update.command.action, {
      kind: "entity-update",
      entityKind: "software/coding/architecture-decision-record@1",
      entityId: "ADR-abc",
      title: "Revised",
      locator: "docs/revised.md",
      contentVersion: "git:abc",
      expectedVersion: 7,
    });
  const archive = parseThinCommand([
    "entity",
    "archive",
    "software/coding/architecture-decision-record@1",
    "--id",
    "ADR-abc",
    "--reason",
    "Superseded",
    "--expected-version",
    "8",
  ]);
  assert.equal(archive.ok, true);
  if (archive.ok)
    assert.deepEqual(archive.command.action, {
      kind: "entity-archive",
      entityKind: "software/coding/architecture-decision-record@1",
      entityId: "ADR-abc",
      reason: "Superseded",
      expectedVersion: 8,
    });
});

test("vertical entity-kind commands coexist with the existing vertical command surface", () => {
  const validate = parseThinCommand(["vertical", "validate", "--source", "software/coding"]),
    upsert = parseThinCommand(["vertical", "entity-kind", "upsert", "--from-file", "kind.json"]);
  assert.equal(validate.ok, true);
  if (validate.ok)
    assert.deepEqual(validate.command.action, {
      kind: "vertical-validate",
      verticalSource: "software/coding",
    });
  assert.equal(upsert.ok, true);
  if (upsert.ok) assert.deepEqual(upsert.command.action, { kind: "vertical-kind-upsert", fromFile: "kind.json" });
  const retire = parseThinCommand(["vertical", "entity-kind", "retire", "runbook", "--reason", "Superseded"]);
  assert.equal(retire.ok, true);
  if (retire.ok)
    assert.deepEqual(retire.command.action, {
      kind: "vertical-kind-retire",
      kindId: "runbook",
      reason: "Superseded",
    });
  assert.equal(parseThinCommand(["vertical", "entity-kind", "retire", "runbook"]).ok, false);
  const publish = parseThinCommand([
    "vertical",
    "entity-kind",
    "publish-schema",
    "runbook",
    "--from-file",
    "attributes.json",
  ]);
  assert.equal(publish.ok, true, JSON.stringify(publish));
  if (publish.ok)
    assert.deepEqual(publish.command.action, {
      kind: "vertical-kind-publish-schema",
      kindId: "runbook",
      fromFile: "attributes.json",
    });
  assert.equal(parseThinCommand(["vertical", "entity-kind", "publish-schema", "runbook"]).ok, false);
});

test("retired mutation migrations are explicitly absent from the thin router", () => {
  for (const argv of [
    ["migrate", "rekey-facts"],
    ["migrate", "relation-events"],
    ["migrate", "decision-digests"],
    ["migrate", "schedule-definitions"],
    ["migrate", "settings-wal-flush"],
    ["migrate", "dispatch-records"],
    ["migrate", "squads"],
  ])
    assert.equal(parseThinCommand(argv).ok, false, argv.join(" "));
});

test("capabilities is an exact-set projection of the command contract", () => {
  assert.deepEqual(cliCapabilities, {
    agenda: ["agenda"],
    backup: ["ledger-backup"],
    agent: [
      "agent-create",
      "agent-delete",
      "agent-inspect",
      "agent-install",
      "agent-list",
      "agent-run",
      "agent-validate",
    ],
    ci: ["ci-observe-pull"],
    daemon: [
      "daemon-connection-add",
      "daemon-connection-probe",
      "daemon-connection-remove",
      "daemon-connection-update",
      "daemon-fleet-center-start",
      "daemon-fleet-edge-sync",
      "daemon-projection-rebuild",
      "daemon-repo-register",
      "daemon-repo-update",
      "daemon-start",
      "daemon-status",
      "daemon-stop",
    ],
    repo: ["repo-purge", "repo-unbind"],
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
    doctor: ["doctor", "doctor-health"],
    entity: ["entity-archive", "entity-delete", "entity-get", "entity-import", "entity-list", "entity-update"],
    event: ["event-list", "event-show"],
    explain: ["explain"],
    fact: ["fact-reclassify", "fact-record", "fact-search", "fact-show", "fact-type-list", "fact-type-register"],
    gui: ["gui"],
    init: ["repo-bootstrap"],
    ledger: ["ledger-reconcile"],
    migrate: ["migrate-import", "migrate-ledger", "vertical-declaration-migrate"],
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
    relation: ["relation-list", "relation-reconfirm", "relation-relate", "relation-triples", "relation-unrelate"],
    restore: ["ledger-restore-drill", "ledger-restore-offline"],
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
      "schedule-runs",
      "schedule-show",
      "schedule-update",
    ],
    script: ["preset-run-start", "script-inspect", "script-list", "script-run"],
    settings: ["settings-read", "settings-show", "settings-update"],
    people: [
      "people-add",
      "people-bind",
      "people-delegate",
      "people-remove",
      "people-revoke-delegation",
      "people-set-role",
    ],
    squad: [
      "squad-cancel",
      "squad-delete",
      "squad-inspect",
      "squad-install",
      "squad-list",
      "squad-run",
      "squad-status",
      "squad-validate",
    ],
    task: [
      "task-amend",
      "task-annotate",
      "task-archive",
      "task-artifact-add",
      "task-attest",
      "task-code-doc-reconcile",
      "task-code-doc-repoint",
      "task-complete",
      "task-contract-migrate",
      "task-create",
      "task-declare-executor",
      "task-delete",
      "task-dispatch-review",
      "task-dispatches",
      "task-list",
      "task-pin",
      "task-progress-append",
      "task-read-set",
      "task-release",
      "task-reopen",
      "task-review",
      "task-review-consent",
      "task-review-execution",
      "task-settle",
      "task-show",
      "task-start",
      "task-submit",
      "task-supersede",
      "task-transition",
      "task-unpin",
    ],
    template: ["template-list", "template-render"],
    vertical: [
      "vertical-kind-publish-schema-cli",
      "vertical-kind-retire-cli",
      "vertical-kind-upsert-cli",
      "vertical-validate",
    ],
  });
});

test("event commands project list filters and the show positional into read actions", () => {
  const list = parseThinCommand([
    "event",
    "list",
    "--type",
    "settings_changed",
    "--actor",
    "codex",
    "--after",
    "2026-09-01T00:00:00Z",
    "--limit",
    "25",
    "--cursor",
    "40",
  ]);
  assert.equal(list.ok, true, JSON.stringify(list));
  if (list.ok) {
    assert.equal(list.command.method, "repo.task.read");
    assert.deepEqual(list.command.action, {
      kind: "event-list",
      type: "settings_changed",
      actor: "codex",
      after: "2026-09-01T00:00:00Z",
      limit: 25,
      cursor: "40",
    });
  }
  const show = parseThinCommand(["event", "show", "op-1"]);
  assert.equal(show.ok, true);
  if (show.ok) {
    assert.equal(show.command.method, "repo.task.read");
    assert.deepEqual(show.command.action, { kind: "event-show", opId: "op-1" });
  }
  assert.equal(parseThinCommand(["event", "show"]).ok, false);
  assert.equal(parseThinCommand(["event", "list", "--limit", "0"]).ok, false);
  assert.equal(parseThinCommand(["event", "list", "--limit", "501"]).ok, false);
  assert.equal(parseThinCommand(["event", "list", "--after", "yesterday"]).ok, false);
});

test("event list renders revision-descending rows and event show renders the full event JSON", () => {
  const listReceipt = {
    ok: true,
    command: "event-list",
    outcome: "applied",
    evidence: JSON.stringify({
      schema: "event-list/v1",
      rows: [
        {
          revision: 7,
          opId: "op-7",
          eventId: "event-7",
          schema: "settings-event/v1",
          type: "settings_changed",
          occurredAt: "2026-09-01T00:00:07.000Z",
          actor: { personId: "person-a", executorId: "codex" },
          entityRefs: [],
        },
      ],
      page: { limit: 50, cursor: null, nextCursor: "7" },
    }),
  };
  const listText = renderCliReceipt(listReceipt).text;
  assert.match(listText, /^7 \| 2026-09-01T00:00:07\.000Z \| settings_changed \| op-7 \| codex$/mu);
  assert.match(listText, /more: use --cursor 7/u);
  const showReceipt = {
    ok: true,
    command: "event-show",
    outcome: "applied",
    evidence: JSON.stringify({
      schema: "event-show/v1",
      event: { eventId: "event-7", opId: "op-7", payload: { nested: true } },
    }),
  };
  assert.equal(
    renderCliReceipt(showReceipt).text,
    JSON.stringify({ eventId: "event-7", opId: "op-7", payload: { nested: true } }, null, 2),
  );
});

test("task transition leaves lifecycle eligibility to the kernel", () => {
  for (const argv of [
    ["task", "transition", "task-1", "planned"],
    ["task", "transition", "task-1", "cancelled"],
    ["task", "transition", "task-1", "cancelled", "--force"],
    ["task", "transition", "task-1", "cancelled", "--reason", "Scope withdrawn"],
    ["task", "transition", "task-1", "active", "--force"],
  ])
    assert.equal(parseThinCommand(argv).ok, true, argv.join(" "));
  assert.equal(
    parseThinCommand(["task", "transition", "task-1", "planned", "--reason", "Owner adjudicated rollback"]).ok,
    true,
  );
  assert.equal(
    parseThinCommand(["task", "transition", "task-1", "cancelled", "--force", "--reason", "Scope withdrawn"]).ok,
    true,
  );
});

test("task contract migration carries an explicit target preset through the thin CLI", () => {
  for (const mode of ["--apply", "--dry-run"]) {
    const parsed = parseThinCommand([
      "task",
      "contract",
      "migrate",
      "--task",
      "task_example",
      "--to-preset",
      "docs-task",
      mode,
    ]);
    assert.equal(parsed.ok, true);
    if (parsed.ok)
      assert.deepEqual(parsed.command.action, {
        kind: "task-contract-migrate",
        taskId: "task_example",
        toPresetId: "docs-task",
        mode: mode === "--apply" ? "apply" : "dry-run",
      });
  }
});

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

  const receiptRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "ha-receipt-golden-"));
  try {
    mkdirSync(path.join(receiptRoot, "harness"));
    writeFileSync(path.join(receiptRoot, "harness/harness.yaml"), "");
    const taskOutput = captureStdout(() =>
        emit(
          {
            ok: true,
            command: "task-create",
            summary: "created task task-one at harness/tasks/task-one",
            taskId: "task-one",
            packagePath: "tasks/task-one",
            presetId: "standard-task",
            profileId: "baseline",
            outputShape: "repository-diff",
            completionGates: ["ci", "code-doc-reconciliation"],
            dryRun: false,
            proof: { canonicalVisible: true },
            guidance: taskCreateGuidance(resolveHarnessLayout(receiptRoot), {
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
        "created task task-one at harness/tasks/task-one",
        "preset: standard-task/baseline",
        "outputShape: repository-diff",
        'completionGates: ["ci","code-doc-reconciliation"]',
        expectedContract,
        "next: edit harness/tasks/task-one/task_plan.md, then run ha doc sync --submit --path " +
          "tasks/task-one/task_plan.md, then run ha task start task-one",
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
  } finally {
    rmSync(receiptRoot, { recursive: true, force: true });
  }
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
      packageSource: path.resolve("package"),
    });
  if (install.ok)
    assert.deepEqual(install.command.action, {
      kind: "preset-install",
      packageSource: path.resolve("package"),
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
  const tasked = parseThinCommand(["ci", "observe", "pull", "--task", "task-1"]);
  assert.equal(tasked.ok, true, JSON.stringify(tasked));
  if (tasked.ok) assert.deepEqual(tasked.command.action, { kind: "ci-observe-pull", taskId: "task-1" });
  const conflicting = parseThinCommand(["ci", "observe", "pull", "--task", "task-1", "--run", "34091151001"]);
  assert.equal(conflicting.ok, false);
  if (!conflicting.ok) assert.match(conflicting.nextAction, /mutually exclusive/u);
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
    code: "unknown_field",
    nextAction: "Unknown option --policy-conformance-probe. Run ha task show --help.",
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

const frozenMutations = Object.freeze([
  { commandId: "task-create", inputName: "--title", facet: "required", argv: ["task", "create"] },
  { commandId: "task-submit", inputName: "--execution-id", facet: "kind", argv: ["task", "submit", "task-1"] },
  { commandId: "task-create", inputName: "--title", facet: "name", argv: ["task", "create"] },
  { commandId: "task-create", inputName: "--title", facet: "error", argv: ["task", "create"] },
  {
    commandId: "fact-search",
    inputName: "--confidence",
    facet: "enum",
    argv: ["fact", "search", "--confidence", "impossible"],
  },
  {
    commandId: "fact-show",
    inputName: "--id",
    facet: "regex",
    argv: ["fact", "show", "--id", "bad"],
  },
  {
    commandId: "fact-record",
    inputName: "--memory-tag",
    facet: "repeated",
    argv: ["fact", "record", "--task", "task-1", "--statement", "s", "--source", "src", "--memory-tag", "a"],
  },
  {
    commandId: "decision-show",
    inputName: "--include-body",
    facet: "boolean",
    argv: ["decision", "show", "dec_1", "--include-body"],
  },
] as const);

test("all public commands expose the canonical structured input facet", () => {
  for (const command of daemonProtocolCommands) {
    assert.equal(Object.hasOwn(command, "inputs"), true, `${command.id}: explicit inputs`);
    assert.deepEqual(deriveThinCliInputs(command), command.inputs, command.id);
    assert.equal(
      command.inputs.every(
        (input) => input.name.startsWith("--") && Object.hasOwn(input, "required") && Object.hasOwn(input, "error"),
      ),
      true,
      command.id,
    );
  }
  for (const id of ["preset-upgrade", "daemon-projection-rebuild", "daemon-start", "daemon-status"])
    assert.deepEqual(daemonProtocolCommands.find((command) => command.id === id)?.inputs, [], id);
  // task show accepts the id positionally or as --id; both spellings land on the same action field.
  assert.deepEqual(
    daemonProtocolCommands
      .find((command) => command.id === "task-show")
      ?.inputs.map(({ name, kind, required, field }) => [name, kind, required, field]),
    [["--id", "single", false, "taskId"]],
    "task-show",
  );
  // doc-materialize mirrors doc-sync-submit's confirmation gate surface: a repeated --path for an
  // explicit selection and a boolean --all that excludes it.
  assert.deepEqual(
    daemonProtocolCommands
      .find(({ id }) => id === "doc-materialize")
      ?.inputs.map(({ name, kind, required, conflictsWith }) => [name, kind, required, conflictsWith]),
    [
      ["--path", "repeated", false, undefined],
      ["--all", "boolean", false, ["--path"]],
    ],
    "doc-materialize",
  );
  assert.deepEqual(
    daemonProtocolCommands
      .find(({ id }) => id === "receipt-show")
      ?.inputs.map(({ name, kind, required }) => [name, kind, required]),
    [
      ["--wait", "single", false],
      ["--timeout-ms", "single", false],
    ],
    "receipt-show",
  );
  const ledgerReconcile = daemonProtocolCommands.find((command) => command.id === "ledger-reconcile");
  assert.deepEqual(
    ledgerReconcile?.inputs.map((input) => [input.name, input.kind, input.required]),
    [["--generation", "single", true]],
    "ledger-reconcile",
  );
  // daemon-stop is the one daemon control with a flag: --force is the supported escalation when
  // a cooperative stop times out, and the usage line is derived from this declaration.
  const daemonStop = daemonProtocolCommands.find((command) => command.id === "daemon-stop");
  assert.deepEqual(
    daemonStop?.inputs.map((input) => [input.name, input.kind]),
    [["--force", "boolean"]],
    "daemon-stop",
  );
  assert.match(daemonStop?.usage ?? "", /daemon stop \[--force\]/u, "daemon-stop");
  const scheduleRuns = daemonProtocolCommands.find((command) => command.id === "schedule-runs");
  assert.deepEqual(
    scheduleRuns?.inputs.map((input) => [input.name, input.kind, input.required, input.regex]),
    [["--limit", "single", false, "^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$"]],
    "schedule-runs",
  );
  for (const id of [
    "task-review-execution",
    "people-add",
    "people-set-role",
    "people-bind",
    "people-delegate",
    "people-revoke-delegation",
    "people-remove",
    "schedule-show",
    "schedule-update",
    "schedule-delete",
  ]) {
    const command = daemonProtocolCommands.find((candidate) => candidate.id === id),
      fromFile = command?.inputs.find((input) => input.name === "--from-file"),
      jsonInput = command?.inputs.find((input) => input.name === "--json-input");
    assert.ok(fromFile && jsonInput, `${id}: structured packet inputs`);
    assert.equal(fromFile.kind, "single", id);
    assert.equal((fromFile.jsonFields?.length ?? 0) > 0, true, `${id}: JSON required fields`);
    assert.equal(
      (fromFile.jsonAllowedFields ?? fromFile.jsonFields ?? []).length >= (fromFile.jsonFields?.length ?? 0),
      true,
      id,
    );
    assert.deepEqual(jsonInput.jsonFields, fromFile.jsonFields, `${id}: JSON required fields match`);
    assert.deepEqual(jsonInput.jsonAllowedFields, fromFile.jsonAllowedFields, `${id}: JSON allowed fields match`);
    assert.equal(jsonInput.format, "<json|@->", `${id}: stdin format`);
    assert.equal(fromFile.format, workspacePathFormat, `${id}: workspace path rule`);
    assert.equal(fromFile.conflictsWith?.includes("--json-input"), true, `${id}: file conflict`);
    assert.equal(jsonInput.conflictsWith?.includes("--from-file"), true, `${id}: inline conflict`);
  }
  const reviewConsent = daemonProtocolCommands.find((command) => command.id === "task-review-consent");
  assert.ok(reviewConsent);
  for (const name of ["--consent-id", "--from-file", "--json-input"])
    assert.equal(
      reviewConsent.inputs.some((input) => input.name === name),
      false,
      name,
    );
  const taskSubmit = daemonProtocolCommands.find((command) => command.id === "task-submit");
  assert.ok(taskSubmit);
  for (const name of ["--from-file", "--json-input"])
    assert.equal(
      taskSubmit.inputs.some((input) => input.name === name),
      false,
    );
  assert.deepEqual(
    daemonProtocolCommands
      .find((command) => command.id === "task-code-doc-reconcile")
      ?.inputs.map((input) => [input.name, input.required]),
    [["--path", true]],
  );
  assert.deepEqual(
    daemonProtocolCommands.find((command) => command.id === "task-code-doc-repoint")?.inputs.map((input) => input.name),
    ["--record", "--path", "--reason"],
  );
});

test("daemon command declarations keep their declared positional in usage", () => {
  // Both commands declare required inputs in their defining module; those declarations must not silently
  // drop the positional or required flags from the rendered usage.
  const taskStart = daemonProtocolCommands.find((command) => command.id === "task-start");
  assert.ok(taskStart);
  assert.match(taskStart.usage, /task start <task-id>/u);
  const repoBootstrap = daemonProtocolCommands.find((command) => command.id === "repo-bootstrap");
  assert.ok(repoBootstrap);
  assert.match(repoBootstrap.usage, /--repo-id <repo-id>/u);
});

test("closed-field violations bind the rejected name to the legal field table", () => {
  assert.equal(
    unknownFieldViolation({ schema: "probe", permissionMode: "bypass" }, ["schema", "permission-mode"]),
    'unknown field "permissionMode"; allowed fields: "schema", "permission-mode".',
  );
  assert.equal(unknownFieldViolation({ schema: "probe" }, ["schema", "permission-mode"]), null);
});

// #1572: the CLI executor-injection surface is derived from the daemon shapes (daemonMethodAcceptsPayloadExecutor),
// not a hand-copied method list. This register reconciles both directions: the reviewed surface below, and the
// real wire validator — wherever injection may happen, validateDaemonRpcCall must accept the field, and wherever
// a payload envelope exists without the declaration, the validator must reject the field. A newly contracted
// command therefore needs no CLI edit to stay un-injected, and removing a declaration from an injected method
// fails here instead of silently dropping attribution.
const reviewedExecutorSurface = Object.freeze([
  "repo.task.create",
  "repo.preset.list",
  "repo.preset.inspect",
  "repo.preset.check",
  "repo.preset.validate",
  "repo.preset.install",
  "repo.preset.seed",
  "repo.preset.audit",
  "repo.preset.uninstall",
  "repo.preset.upgrade",
  "repo.vertical.validate",
  "repo.template.list",
  "repo.template.render",
  "repo.script.list",
  "repo.script.inspect",
  "repo.script.run",
  "repo.preset.run.start",
  "repo.preset.run.status",
  "repo.agentRuntime.spawn",
  "repo.entity.actions.explain",
] as const);
const agent = Object.freeze({ kind: "agent", id: "parity-probe" });
const payloadShapeOf = (params: (typeof DAEMON_RPC_SCHEMA.methods)[number]["params"]) => {
  const payload = params.fields.payload;
  return typeof payload === "object" && payload !== null && "fields" in payload ? payload : null;
};

test("executor injection follows the daemon-declared surface exactly", () => {
  for (const { method, params } of DAEMON_RPC_SCHEMA.methods) {
    const accepts = daemonMethodAcceptsPayloadExecutor(method),
      payload = payloadShapeOf(params);
    const errors = validateDaemonRpcCall({
      method,
      params: { repo: { repoId: "parity" }, payload: { executor: agent } },
    });
    const executorRejected = errors.some((error) =>
      error.includes('params.payload contains an unknown field "executor"'),
    );
    assert.equal(
      accepts,
      reviewedExecutorSurface.includes(method),
      `${method}: derived surface matches the reviewed register`,
    );
    if (accepts)
      assert.equal(executorRejected, false, `${method}: the validator must accept a declared payload executor`);
    else if (payload && !payload.open)
      assert.equal(executorRejected, true, `${method}: an undeclared payload executor must be rejected`);
    else if (!payload)
      assert.equal(
        errors.some((error) => error.includes('params contains an unknown field "payload"')),
        true,
        `${method}: carries no payload envelope at all`,
      );
  }
  // The legacy read envelope keeps its executor inside the open action, like the write envelope.
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.task.read",
      params: { repo: { repoId: "parity" }, payload: { action: { kind: "task-list", executor: agent } } },
    }),
    [],
  );
  assert.equal(daemonMethodAcceptsPayloadExecutor("repo.task.read"), false);
  assert.equal(daemonMethodAcceptsPayloadExecutor("repo.not.contracted"), false);
});

test("frozen public-parser mutations kill every canonical input facet", () => {
  for (const mutation of frozenMutations) {
    const command = daemonProtocolCommands.find((candidate) => candidate.id === mutation.commandId);
    assert.ok(command, mutation.commandId);
    const input = command.inputs.find((candidate) => candidate.name === mutation.inputName);
    assert.ok(input, `${mutation.commandId}:${mutation.inputName}`);
    if (["required", "kind", "name", "error", "enum", "regex"].includes(mutation.facet))
      assert.equal(Object.hasOwn(input, mutation.facet), true, `${mutation.commandId}:${mutation.facet}`);
    const removeInput = mutation.facet === "repeated" || mutation.facet === "boolean",
      inputs = removeInput
        ? command.inputs.filter((candidate) => candidate.name !== mutation.inputName)
        : command.inputs.map((candidate) =>
            candidate.name === mutation.inputName
              ? Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== mutation.facet))
              : candidate,
          ),
      mutatedCommand = { ...command, inputs, flags: inputs },
      catalog = daemonProtocolCommands.map((candidate) =>
        candidate.id === command.id ? mutatedCommand : candidate,
      ) as unknown as typeof daemonProtocolCommands;
    const baseline = parseThinCommand(mutation.argv);
    if (["required", "kind", "name", "error"].includes(mutation.facet))
      assert.throws(
        () => parseThinCommand(mutation.argv, process.cwd(), catalog),
        undefined,
        `${mutation.commandId}:${mutation.facet}`,
      );
    else {
      const mutant = parseThinCommand(mutation.argv, process.cwd(), catalog);
      assert.notDeepEqual(mutant, baseline, `${mutation.commandId}:${mutation.facet}`);
      assert.equal(
        removeInput ? baseline.ok && !mutant.ok : !baseline.ok && mutant.ok,
        true,
        `${mutation.commandId}:${mutation.facet}`,
      );
    }
  }
});
