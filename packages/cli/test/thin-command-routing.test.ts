// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { daemonProtocolCommands, thinCliCommands } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { deriveCliCapabilities, parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";
import { main } from "../src/index.ts";

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
  assert.match(logs[0] ?? "", /migrate ledger/u);
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
  assert.deepEqual(deriveCliCapabilities(), {
    agenda: ["agenda"],
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
      "daemon-repo-unregister",
      "daemon-repo-update",
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
    entity: ["entity-archive", "entity-delete", "entity-get", "entity-import", "entity-list", "entity-update"],
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
    settings: ["settings-read", "settings-update"],
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
      "task-archive",
      "task-artifact-add",
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
      "task-read-set",
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
    vertical: [
      "vertical-kind-publish-schema-cli",
      "vertical-kind-retire-cli",
      "vertical-kind-upsert-cli",
      "vertical-validate",
    ],
  });
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
