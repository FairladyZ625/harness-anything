// harness-test-tier: fast
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditDurableActionAuthorization, main } from "../ontology-durable-action-authorization.mjs";
import { captureGate, runGit, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// The gate enumerates through git, so fixture roots must be repositories; the
// local excludesFile pin keeps the host user's global ignores out of the test.
function makeGateRoot(prefix) {
  const rootDir = mkdtempSync(path.join(tmpdir(), prefix));
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    runGit(rootDir, args);
  return rootDir;
}

test("G0-2 reports the base advisory and names an action whose AuthorizationPort call is removed", (t) => {
  assert.equal(captureGate(() => main(["--root", repoRoot])).code, 0);
  const rootDir = makeGateRoot("ontology-action-authorization-");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const actionFixture = path.join(rootDir, "durable-actions.json");
  writeRepoFile(rootDir, "durable-actions.json", '["durable-write"]\n');
  writeRepoFile(
    rootDir,
    "packages/daemon/src/authorization.ts",
    [
      "interface AuthorizationPort { authorize(action: unknown): unknown }",
      "const daemonAuthorizationPort: AuthorizationPort = { authorize: (action) => action };",
      "export function authorizeAction(action: unknown) { return daemonAuthorizationPort.authorize(action); }",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    rootDir,
    "packages/kernel/src/domain/receipt-domain-registry.ts",
    "interface WriteReceipt { readonly authorizationDecision: AuthorizationDecision }\n",
  );
  const handlerPath = "packages/daemon/src/action-handler.ts";
  writeRepoFile(
    rootDir,
    handlerPath,
    'function execute(action: { kind: string }) { if (action.kind === "durable-write") return authorizeAction(action); }\n',
  );
  assert.equal(auditDurableActionAuthorization(rootDir, ["durable-write"]).rows[0].authorizationPort, true);

  writeRepoFile(
    rootDir,
    handlerPath,
    'function execute(action: { kind: string }) { if (action.kind === "durable-write") return action; }\n',
  );
  const result = auditDurableActionAuthorization(rootDir, ["durable-write"]);
  assert.equal(result.rows[0].authorizationPort, false);
  assert.match(result.findings.join("\n"), /durable-write: durable execution path/u);
  const positive = captureGate(() => main(["--root", rootDir, "--fixture", actionFixture, "--mode", "ratchet"]));
  assert.equal(positive.code, 1);
  assert.match(positive.stdout, /durable-write \| missing/u);
});

const retiredHostKinds = [
  "daemon-connection-add",
  "daemon-connection-probe",
  "daemon-connection-remove",
  "daemon-connection-update",
  "daemon-repo-update",
  "ledger-backup",
  "ledger-restore-drill",
  "rbac-bootstrap",
];

// Independent production snapshots: mutate the implementation, never the checker's expectations.
function hostSnapshot(t) {
  const root = makeGateRoot("ontology-host-authorization-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["packages/daemon/src", "packages/authorization-keycloak/src", "packages/application/src"])
    cpSync(path.join(repoRoot, directory), path.join(root, directory), { recursive: true });
  const receipt = "packages/kernel/src/domain/receipt-domain-registry.ts";
  writeRepoFile(root, receipt, readFileSync(path.join(repoRoot, receipt), "utf8"));
  return root;
}

function mutate(root, name, before, after, unique = false) {
  const file = name.includes("/") ? name : `packages/daemon/src/${name}.ts`,
    source = readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");
  assert.ok(source.includes(before), `mutation anchor missing in ${name}: ${before}`);
  if (unique) assert.equal(source.split(before).length - 1, 1, `ambiguous mutation anchor in ${name}: ${before}`);
  writeRepoFile(root, file, source.replaceAll(before, after));
}

for (const newline of ["\n", "\r\n"]) {
  test(`G0-2 mutation removes a multiline return with ${newline === "\n" ? "LF" : "CRLF"} and rejects missing anchors`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ontology-mutation-")),
      file = "packages/daemon/src/fixture.ts",
      before = 'if (decision.outcome === "denied")\n  return rejected();',
      after = 'if (decision.outcome === "denied")\n  rejected();';
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeRepoFile(root, file, before.replaceAll("\n", newline));
    mutate(root, "fixture", before, after);
    assert.equal(readFileSync(path.join(root, file), "utf8"), after);
    assert.throws(() => mutate(root, "fixture", before, after), /mutation anchor missing in fixture/u);
    writeRepoFile(root, file, [before, before].join(newline));
    assert.throws(() => mutate(root, "fixture", before, after, true), /ambiguous mutation anchor in fixture/u);
  });
}

test("G0-2 traces actual Keycloak host routes and the distinct one-time bootstrap boundary", (t) => {
  const root = hostSnapshot(t),
    result = auditDurableActionAuthorization(root, retiredHostKinds);
  assert.deepEqual(result.findings, []);
  assert.equal(result.rows.length, 8);
});

for (const mutation of [
  {
    name: "host entry authorization",
    file: "daemon-host-repository-api",
    before: "requireAuthorizedHostAction({",
    after: "uncheckedHostAction({",
    missing: ["daemon-repo-update", "ledger-backup", "ledger-restore-drill"],
  },
  {
    name: "connection authorization",
    file: "daemon-host-repository-api",
    before: "requireAuthorizedFleetAction({",
    after: "uncheckedFleetAction({",
    missing: retiredHostKinds.filter((kind) => kind.startsWith("daemon-connection-")),
  },
  {
    name: "host denial rejection",
    file: "host-action-authorization",
    before: 'decision.outcome === "denied"',
    after: 'decision.outcome === "allowed"',
    missing: retiredHostKinds,
  },
  {
    name: "Keycloak person evaluation",
    file: "host-action-authorization",
    before: "await evaluateKeycloakPerson({",
    after: "await uncheckedPerson({",
    missing: retiredHostKinds.filter((kind) => kind !== "rbac-bootstrap"),
  },
  {
    name: "session adapter authorization",
    file: "repo-cell-authorization",
    before: "decisionProvider.authorize({",
    after: "decisionProvider.unchecked({",
    missing: retiredHostKinds.filter((kind) => kind !== "rbac-bootstrap"),
  },
  {
    name: "center adapter authorization",
    file: "repo-cell-authorization",
    before: "centerProvider!.authorizePerson({",
    after: "centerProvider!.uncheckedPerson({",
    missing: retiredHostKinds.filter((kind) => kind !== "rbac-bootstrap"),
  },
  {
    name: "bootstrap local transport check",
    file: "daemon-host-open",
    before: "      localOnly(auth);",
    after: "      observeTransport(auth);",
    missing: ["rbac-bootstrap"],
  },
  {
    name: "bootstrap socket owner binding",
    file: "daemon-host-open",
    before: "binding: localSystemBinding(input.userRoot)",
    after: "binding: request.binding",
    missing: ["rbac-bootstrap"],
  },
  {
    name: "bootstrap socket owner qualification",
    file: "host-action-authorization",
    before: "input.binding.daemonSocketOwner === true",
    after: "true",
    missing: ["rbac-bootstrap"],
  },
  {
    name: "bootstrap canonical write exclusion",
    file: "host-action-authorization",
    before: 'declaration.residency.scope !== "canonical"',
    after: "true",
    missing: ["rbac-bootstrap"],
  },
  {
    name: "bootstrap one-time rejection",
    file: "packages/authorization-keycloak/src/oidc-session-service.ts",
    before: 'throw coded("bootstrap_admin_closed", "The first Harness administrator already exists.");',
    after: "return { ok: true };",
    missing: ["rbac-bootstrap"],
  },
  {
    name: "bootstrap serialization",
    file: "packages/authorization-keycloak/src/oidc-session-service.ts",
    before: "return this.serialize(async () => {",
    after: "return independently(async () => {",
    missing: ["rbac-bootstrap"],
  },
])
  test(`G0-2 rejects removal of ${mutation.name}`, (t) => {
    const root = hostSnapshot(t);
    mutate(root, mutation.file, mutation.before, mutation.after);
    const result = auditDurableActionAuthorization(root, retiredHostKinds);
    for (const kind of mutation.missing)
      assert.equal(result.rows.find((row) => row.action === kind)?.authorizationPort, false, kind);
  });

function taskSnapshot(t) {
  const root = hostSnapshot(t);
  cpSync(path.join(repoRoot, "packages/kernel/src"), path.join(root, "packages/kernel/src"), { recursive: true });
  return root;
}

test("G0-2 traces all 176 declared writes, including repository Todo actions", () => {
  const result = auditDurableActionAuthorization(repoRoot);
  // dec_4190D5EA63D9DD208CE946F133 and dec_5EC2631352B17EE2BF4979E37E authorize four Task GateRun writes.
  // dec_2AAF1D0612D3295C80F87E49FE CH1 authorizes daemon-mediated task push.
  // dec_F01770FD0DCF72683B7C4C7A47/CH4 authorizes the three permission request lifecycle actions.
  // dec_12A87C0F08E4B8304C4BC25BA7/CH1,CH4: authorized runtime steering action.
  // dec_4C06F7F902E91C4210020A9E75/CH2 retires task-ci; dec_FC266F3F44CD241481B7066540/CH1 authorizes six Decisions Provider actions.
  // Owner 2026-10-21 (W2, dec_E369B8616F50A6208B293997E7) deletes task-pr: PRs and CI waits move to the worker's gh.
  // Owner 2026-10-21 B3 deletes the code/doc reconcile and repoint writes with the mechanism.
  // dec_E369B8616F50A6208B293997E7/CH5 (W2-2) deletes task-adjudicate with the manual forward/return commands.
  // The owner's 2026-10-24 decision-supersede deletion (task_a242ec14) and this task-adjudicate
  // deletion are both in this inventory: 166 -> 164; task-respond-review and task-rework add the current 166th.
  // task_90599b2e80d7db778e96419a2f (agenda B15) adds runtime-incident-dismiss: the owner's explicit close of an incident receipt.
  // task_8c579f0d2c896668e2fd92ab85 adds six canonical Todo writes; list/show remain repository reads.
  // dec_2446BC2F8C68630F71AE3E3BD7 CH6 and dec_6C9E3399972A2F06C046BA89DC CH1 remove task-pin/unpin-only declarations.
  // task_c42e93a6c384624aba591b9b8b adds two owner-ruling writes through Task authorization.
  // dec_D90F19C8AAAF39747F8F0D6698/CH20 adds the queued migration admin action.
  // dec_2C72644059ACA2D4BE30C07786/CH1 adds access-manage to the protocol inventory.
  // task_6569c05452127015cf461219de adds the node-local auto-claim host action.
  // task_b61f743f47a04298a7a96704e0 adds the declared-source witness-run action.
  assert.equal(result.rows.length, 176);
  assert.equal(result.rows.find(({ action }) => action === "task-respond-review")?.authorizationPort, true);
  for (const action of [
    "task-escalate",
    "task-escalation-resolve",
    "daemon-node-auto-claim",
    "migrate-storage",
    "task-witness-run",
  ])
    assert.equal(result.rows.find((row) => row.action === action)?.authorizationPort, true, action);
  assert.equal(
    result.rows.some(
      ({ action }) =>
        action === "task-ci" ||
        action === "ci-observe-pull" ||
        action === "task-code-doc-reconcile" ||
        action === "task-code-doc-repoint",
    ),
    false,
  );
  assert.deepEqual(result.findings, []);
  assert.ok(result.rows.every((row) => row.receiptAuthorizationDecision));
});

// Each declared Task action must retain its own authorization route.
for (const operation of ["claim", "settle", "revoke", "rerun"]) {
  const kind = `task-witness-${operation}`;
  test(`G0-2 traces ${kind} through the Task authorization path`, (t) => {
    const result = auditDurableActionAuthorization(taskSnapshot(t), [kind]);
    assert.deepEqual(result.findings, []);
    assert.equal(result.rows[0].authorizationPort, true);
    assert.equal(result.rows[0].receiptAuthorizationDecision, true);
  });
  test(`G0-2 rejects ${kind} when its daemon ingress is disconnected`, (t) => {
    const root = taskSnapshot(t);
    const directory = path.join(root, "packages/daemon/src");
    let removed = 0;
    for (const file of readdirSync(directory, { recursive: true }).filter((file) => file.endsWith(".ts"))) {
      const relative = `packages/daemon/src/${file}`;
      const source = readFileSync(path.join(root, relative), "utf8");
      const literal = JSON.stringify(kind);
      removed += source.split(literal).length - 1;
      writeRepoFile(root, relative, source.replaceAll(literal, JSON.stringify(`disconnected-${kind}`)));
    }
    assert.ok(removed > 0, kind);
    const result = auditDurableActionAuthorization(root, [kind]);
    assert.equal(result.rows[0].authorizationPort, false);
    assert.ok(result.findings.some((finding) => finding.startsWith(`${kind}:`)));
  });
}

const queuedWriteMutations = [
  {
    name: "durable membership",
    file: "repo-cell-command-run",
    before: "(durableActionKinds as readonly string[]).includes(action.kind)",
    after: "false",
  },
  {
    name: "current cut evaluation",
    file: "repo-cell-command-run",
    before: "queuedDecision = await authorizeAtCurrentCut()!;",
    after: "queuedDecision = undefined;",
  },
  {
    name: "current revision",
    file: "repo-cell-command-run",
    before:
      "const revision = context.store.readHead()?.revision ?? 0,\n          actionId = context.operationId(action, binding,",
    after: "const revision = 0,\n          actionId = context.operationId(action, binding,",
  },
  {
    name: "denied return",
    file: "repo-cell-command-run",
    before: 'if (queuedDecision.outcome === "denied")\n            return withAuthorizationDecision(',
    after: 'if (queuedDecision.outcome === "denied")\n            withAuthorizationDecision(',
  },
  {
    name: "execution before authorization",
    file: "repo-cell-command-run",
    before: "const executed = context.withHumanSummary(await execute(queuedDecision)),",
    after: "const executed = context.withHumanSummary(alreadyExecuted),",
    extraBefore: "if (durable) {",
    extraAfter: "const alreadyExecuted = await execute(queuedDecision);\n        if (durable) {",
  },
  {
    name: "Keycloak person evaluation",
    file: "repo-cell-authorization",
    before: "const result = await evaluateKeycloakPerson({",
    after: "const result = await uncheckedPerson({",
  },
  {
    name: "catalog dispatch",
    file: "repo-cell-action-dispatch",
    before: "return cell.entityActionExecutor.run(",
    after: "return uncheckedCatalog(",
  },
  {
    name: "catalog task callback",
    file: "entity-action-catalog-executor",
    before: ".task(contract, action, binding, opId)",
    after: ".uncheckedTask(contract, action, binding, opId)",
  },
  {
    name: "lifecycle execution",
    file: "repo-cell-action-dispatch",
    before: "cell.lifecycleAction(catalogAction, catalogBinding)",
    after: "uncheckedLifecycle(catalogAction, catalogBinding)",
  },
  {
    name: "write entry binding",
    file: "repo-cell-action-context",
    before: "executeAction: bind(executeActionImpl)",
    after: "executeAction: uncheckedExecution",
  },
];

// dec_2AAF1D0612D3295C80F87E49FE CH1: preserve the authorization boundary for prepared push.
test("G0-2 traces task push through the authorized prepared publication", (t) => {
  const result = auditDurableActionAuthorization(taskSnapshot(t), ["task-push"]);
  assert.deepEqual(result.findings, []);
  assert.equal(result.rows[0].authorizationPort, true);
});

for (const mutation of [
  ...queuedWriteMutations.filter(
    ({ name }) => !["catalog dispatch", "catalog task callback", "lifecycle execution"].includes(name),
  ),
  {
    name: "prepared handler import",
    file: "repo-cell-command-run",
    before: 'from "./write-queue-external-reads.ts"',
    after: 'from "./unrelated-preparation.ts"',
  },
  {
    name: "prepared handler call",
    file: "repo-cell-command-run",
    before: "readBeforeWriteQueue(context, action, binding)",
    after: "unrelatedPreparation(context, action, binding)",
  },
  {
    name: "prepared queue callback",
    file: "repo-cell-command-run",
    before: "publish(action, authorizationDecision ? { ...binding, authorizationDecision } : binding)",
    after: "publishUnchecked(action, binding)",
  },
  {
    name: "prepared side effect import",
    file: "write-queue-external-reads",
    before: 'from "./runtime-task-publication.ts"',
    after: 'from "./unrelated-task-publication.ts"',
    // The callback also imports the push-failure classifier; disconnect both local handlers.
    extraBefore: 'from "./runtime-worker-push.ts"',
    extraAfter: 'from "./unrelated-worker-push.ts"',
  },
  {
    name: "prepared publication return",
    file: "write-queue-external-reads",
    before: "return async (_action: RepoTaskAction, executionBinding: RepoCellBinding) => {",
    after: "return async function (_action: RepoTaskAction, executionBinding: RepoCellBinding) {",
  },
]) {
  for (const kind of ["task-push"])
    test(`G0-2 rejects ${kind} when ${mutation.name} is disconnected`, (t) => {
      const root = taskSnapshot(t);
      mutate(root, mutation.file, mutation.before, mutation.after);
      if (mutation.extraBefore) mutate(root, mutation.file, mutation.extraBefore, mutation.extraAfter);
      const result = auditDurableActionAuthorization(root, [kind]);
      assert.equal(result.rows[0].authorizationPort, false);
      assert.equal(result.findings.length, 1);
    });
}

test("G0-2 cannot rescue a disconnected prepared publication through an unrelated authorization call", (t) => {
  const root = taskSnapshot(t);
  // The generic graph can reach this literal, but it does not authorize the prepared publication.
  writeRepoFile(
    root,
    "packages/daemon/src/unrelated-authorization.ts",
    'function unrelated(action) { if (action.kind === "task-push") return authorizeAction(action); }\n',
  );
  assert.equal(auditDurableActionAuthorization(root, ["task-push"]).rows[0].authorizationPort, true);
  mutate(
    root,
    "repo-cell-command-run",
    "readBeforeWriteQueue(context, action, binding)",
    "unrelatedPreparation(context, action, binding)",
  );
  const result = auditDurableActionAuthorization(root, ["task-push"]);
  assert.equal(result.rows[0].authorizationPort, false);
  assert.equal(result.findings.length, 1);
});

test("G0-2 requires task push's durable repo-write declaration", (t) => {
  const root = taskSnapshot(t),
    file = "packages/kernel/src/domain/action-declaration.ts",
    source = readFileSync(path.join(root, file), "utf8");
  const binding = 'canonical("task-push", "task/push", "repo-write", "none")';
  assert.ok(source.includes(binding));
  writeRepoFile(root, file, source.replace(binding, 'canonical("task-push", "task/push", "repo-read", "none")'));
  const result = auditDurableActionAuthorization(root, ["task-push"]);
  assert.equal(result.rows[0].authorizationPort, false);
  assert.equal(result.findings.length, 1);
});

test("G0-2 follows the prepared route rather than allowing a task push action name", (t) => {
  const root = taskSnapshot(t);
  for (const file of [
    "packages/kernel/src/domain/action-declaration.ts",
    "packages/daemon/src/write-queue-external-reads.ts",
  ]) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.ok(source.includes('"task-push"'));
    writeRepoFile(root, file, source.replaceAll('"task-push"', '"fixture-prepared-write"'));
  }
  const result = auditDurableActionAuthorization(root, ["fixture-prepared-write", "task-push"]);
  assert.deepEqual(
    result.rows.map((row) => row.authorizationPort),
    [true, false],
  );
  assert.equal(result.findings.length, 1);
});

for (const mutation of queuedWriteMutations) {
  test(`G0-2 rejects task writes when production ${mutation.name} is disconnected`, (t) => {
    const root = taskSnapshot(t);
    mutate(root, mutation.file, mutation.before, mutation.after);
    if (mutation.extraBefore) mutate(root, mutation.file, mutation.extraBefore, mutation.extraAfter);
    // The assignment-directory read handler remains intact; it cannot prove write authorization.
    const result = auditDurableActionAuthorization(root, ["task-assign", "task-unassign"]);
    assert.deepEqual(
      result.rows.map((row) => row.authorizationPort),
      [false, false],
    );
    assert.equal(result.findings.length, 2);
    assert.ok(result.rows.every((row) => row.receiptAuthorizationDecision));
  });
}

for (const kind of ["assign", "unassign"]) {
  for (const registration of [false, true]) {
    test(`G0-2 rejects task-${kind} after removing its ${registration ? "catalog registration" : "durable declaration"}`, (t) => {
      const root = taskSnapshot(t),
        file = `packages/kernel/src/domain/${registration ? "assignment-action-contract" : "action-declaration"}.ts`,
        source = readFileSync(path.join(root, file), "utf8"),
        before = registration ? `action("${kind}")` : `closure("task-${kind}", "task/${kind}"),`,
        after = registration ? `disconnected("${kind}")` : "";
      assert.ok(source.includes(before));
      writeRepoFile(root, file, source.replace(before, after));
      const result = auditDurableActionAuthorization(root, ["task-assign", "task-unassign"]);
      assert.equal(result.rows.find((row) => row.action === `task-${kind}`).authorizationPort, false);
      assert.equal(result.rows.find((row) => row.action !== `task-${kind}`).authorizationPort, true);
      assert.equal(result.findings.length, 1);
    });
  }
}

// The handler snapshot is from c7f42468aa4bf76a8a36fb68ce3841a2af1eb0e6.
// Give only the queued fixture its own action and handler names. The complete product
// tree may also authorize handoff claim through runtime publication; that independent
// route must not satisfy a mutation of this route. The real inventory is audited above.
const handoffKinds = ["fixture-handoff-export", "fixture-handoff-claim", "fixture-handoff-revoke"];
function handoffSnapshot(t) {
  const root = taskSnapshot(t),
    handler = readFileSync(new URL("./queued-handoff-store.fixture.txt", import.meta.url), "utf8")
      .replaceAll('"runtime-handoff-', '"fixture-handoff-')
      .replaceAll("runRuntimeHandoffAction", "runQueuedHandoffAction"),
    dispatchFile = "packages/daemon/src/repo-cell-action-dispatch.ts",
    declarationFile = "packages/kernel/src/domain/action-declaration.ts",
    handlerImport = 'import { runQueuedHandoffAction } from "./queued-handoff-store.ts";',
    route = `  if ([${handoffKinds.map((kind) => JSON.stringify(kind)).join(", ")}].includes(action.kind))
    return runQueuedHandoffAction(cell, action, binding);`;
  writeRepoFile(root, "packages/daemon/src/queued-handoff-store.ts", handler);
  mutate(
    root,
    "repo-cell-action-dispatch",
    "import { settleTask, submitTask }",
    `${handlerImport}\nimport { settleTask, submitTask }`,
    true,
  );
  mutate(
    root,
    "repo-cell-action-dispatch",
    "  validateCanonicalIdentityInputs(cell, action);",
    `  validateCanonicalIdentityInputs(cell, action);\n${route}`,
    true,
  );
  const source = readFileSync(path.join(root, declarationFile), "utf8"),
    anchor =
      '  local("runtime-cancel", "repo-write", runtimeResidency, { receiptSettlement: "canonical-acceptance" }),',
    declarations = handoffKinds.map((kind) => `  canonical("${kind}", null, "repo-write"),`);
  assert.equal(source.split(anchor).length - 1, 1);
  writeRepoFile(root, declarationFile, source.replace(anchor, [anchor, ...declarations].join("\n")));
  for (const [file, anchors] of [
    [dispatchFile, [handlerImport, route, "return runQueuedHandoffAction(cell, action, binding)"]],
    [declarationFile, declarations],
    ["packages/daemon/src/queued-handoff-store.ts", ["export function runQueuedHandoffAction("]],
  ]) {
    const content = readFileSync(path.join(root, file), "utf8");
    for (const expected of anchors) assert.equal(content.split(expected).length - 1, 1, `${file}: ${expected}`);
  }
  return root;
}

test("G0-2 traces real queued handoff handlers without downstream authorization calls", (t) => {
  const result = auditDurableActionAuthorization(handoffSnapshot(t), handoffKinds);
  assert.deepEqual(result.findings, []);
  assert.ok(result.rows.every((row) => row.authorizationPort && row.receiptAuthorizationDecision));
});

for (const mutation of [
  ...queuedWriteMutations.filter(
    (entry) => !["catalog dispatch", "catalog task callback", "lifecycle execution"].includes(entry.name),
  ),
  {
    name: "queue callback",
    file: "repo-cell-command-run",
    before: "chainRepoCellWrite(context.tail,",
    after: "unconnectedQueue(context.tail,",
  },
  {
    name: "runner callback",
    file: "repo-cell-command-run",
    before: "context.executeAction(action, authorizationDecision ?",
    after: "context.uncheckedAction(action, authorizationDecision ?",
  },
  {
    name: "runner import",
    file: "repo-cell-api",
    before: 'from "./repo-cell-command-run.ts"',
    after: 'from "./unconnected-runner.ts"',
  },
  {
    name: "runner construction",
    file: "repo-cell-api",
    before: "run = makeRepoCellCommandRunner(context)",
    after: "run = unconnectedRunner(context)",
  },
  {
    name: "open binding",
    file: "repo-cell-open",
    before: "executeAction: extracted.executeAction",
    after: "executeAction: extracted.uncheckedAction",
  },
  {
    name: "dispatch import",
    file: "repo-cell-action-context",
    before: 'from "./repo-cell-action-dispatch.ts"',
    after: 'from "./unconnected-dispatch.ts"',
  },
  {
    name: "binding implementation",
    file: "repo-cell-action-context",
    before: "return implementation(actionContext.current as Context, ...args)",
    after: "return unconnectedImplementation(actionContext.current as Context, ...args)",
  },
  {
    name: "dispatch callback",
    file: "repo-cell-action-dispatch",
    before: "Promise.resolve(executeRepoAction(cell, action, binding))",
    after: "Promise.resolve(unconnectedAction(cell, action, binding))",
  },
  {
    name: "handler import",
    file: "repo-cell-action-dispatch",
    before: 'from "./queued-handoff-store.ts"',
    after: 'from "./unconnected-store.ts"',
  },
  {
    name: "handler call",
    file: "repo-cell-action-dispatch",
    before: "return runQueuedHandoffAction(cell, action, binding)",
    after: "return disconnectedHandoff(cell, action, binding)",
  },
  {
    name: "handler arguments",
    file: "repo-cell-action-dispatch",
    before: "return runQueuedHandoffAction(cell, action, binding)",
    after: "return runQueuedHandoffAction(cell, otherAction, binding)",
  },
  {
    name: "handler declaration",
    file: "queued-handoff-store",
    before: "export function runQueuedHandoffAction(",
    after: "export function disconnectedHandoff(",
  },
  {
    name: "handler export",
    file: "queued-handoff-store",
    before: "export function runQueuedHandoffAction(",
    after: "function runQueuedHandoffAction(",
  },
]) {
  test(`G0-2 rejects queued handoff after removing ${mutation.name}`, (t) => {
    const root = handoffSnapshot(t);
    mutate(root, mutation.file, mutation.before, mutation.after, true);
    if (mutation.extraBefore) mutate(root, mutation.file, mutation.extraBefore, mutation.extraAfter, true);
    const result = auditDurableActionAuthorization(root, handoffKinds);
    assert.deepEqual(
      result.rows.map((row) => row.authorizationPort),
      [false, false, false],
    );
    assert.equal(result.findings.length, 3);
  });
}

test("G0-2 does not accept a same-named handler from an unrelated file", (t) => {
  const root = handoffSnapshot(t);
  mutate(
    root,
    "queued-handoff-store",
    "export function runQueuedHandoffAction(",
    "export function disconnectedHandoff(",
    true,
  );
  writeRepoFile(root, "packages/daemon/src/unrelated.ts", "export function runQueuedHandoffAction() { return {}; }");
  assert.ok(auditDurableActionAuthorization(root, handoffKinds).rows.every((row) => !row.authorizationPort));
});

test("G0-2 requires each queued action's durable repo-write declaration", (t) => {
  const root = handoffSnapshot(t),
    file = "packages/kernel/src/domain/action-declaration.ts";
  const original = readFileSync(path.join(root, file), "utf8");
  for (const kind of handoffKinds) {
    const before = `canonical("${kind}", null, "repo-write"),`;
    assert.equal(original.split(before).length - 1, 1);
    writeRepoFile(root, file, original.replace(before, ""));
    const result = auditDurableActionAuthorization(root, handoffKinds);
    assert.equal(result.rows.find((row) => row.action === kind).authorizationPort, false);
    assert.equal(result.findings.length, 1);
  }
});

test("G0-2 follows the declared route instead of allowing handoff action names", (t) => {
  const root = handoffSnapshot(t);
  for (const file of [
    "packages/kernel/src/domain/action-declaration.ts",
    "packages/daemon/src/repo-cell-action-dispatch.ts",
    "packages/daemon/src/queued-handoff-store.ts",
  ]) {
    const original = readFileSync(path.join(root, file), "utf8");
    assert.ok(original.includes("fixture-handoff-export"));
    writeRepoFile(root, file, original.replaceAll("fixture-handoff-export", "fixture-queued-export"));
  }
  const result = auditDurableActionAuthorization(root, ["fixture-queued-export", "fixture-handoff-export"]);
  assert.deepEqual(
    result.rows.map((row) => row.authorizationPort),
    [true, false],
  );
});

// dec_D90F19C8AAAF39747F8F0D6698/CH20: migration grants require the real queued admin authorization.
test("G0-2 traces queued host-local admin actions and rejects a disconnected publication guard", (t) => {
  const root = handoffSnapshot(t),
    file = "packages/kernel/src/domain/action-declaration.ts",
    kind = handoffKinds[0],
    original = readFileSync(path.join(root, file), "utf8"),
    before = `canonical("${kind}", null, "repo-write"),`;
  assert.ok(original.includes(before));
  writeRepoFile(root, file, original.replace(before, `local("${kind}", "admin", hostResidency),`));
  assert.equal(auditDurableActionAuthorization(root, [kind]).rows[0].authorizationPort, true);
  mutate(
    root,
    "repo-cell-command-run",
    "queuedDecision = await authorizeAtCurrentCut()!;",
    "queuedDecision = null as never;",
    true,
  );
  assert.equal(auditDurableActionAuthorization(root, [kind]).rows[0].authorizationPort, false);
});

// dec_2C72644059ACA2D4BE30C07786/CH2: retain negatives when the guard moves off the host shortcut.
for (const mutation of [
  ["queue", "return this.#oidc.serialize(async () => {", "return unchecked(async () => {"],
  [
    "resource guard",
    "await this.#canDecide(session, actor, current.resource)",
    "await this.#canDecide(session, actor, request.resource!)",
  ],
  [
    "denial",
    'throw coded("authorization_denied", `Approver ${actor} cannot decide requests on ${current.resource}.`);',
    "return { ok: true };",
  ],
  ["provider", "session.adapter.authorizePerson({", "session.adapter.unchecked({"],
  ["result", 'return decision.outcome === "allowed";', "return true;"],
  ["dispatch", "return this.#decidePermissionRequest(request, actor);", "return { ok: true };"],
]) {
  test(`G0-2 rejects request decisions after removing ${mutation[0]}`, (t) => {
    const root = hostSnapshot(t);
    assert.equal(auditDurableActionAuthorization(root, ["permission-request-decide"]).rows[0].authorizationPort, true);
    mutate(root, "access-admin-service", mutation[1], mutation[2]);
    assert.equal(auditDurableActionAuthorization(root, ["permission-request-decide"]).rows[0].authorizationPort, false);
  });
}

// dec_2C72644059ACA2D4BE30C07786/CH1: global policy authority is not first-run bootstrap.
for (const mutation of [
  ["session identity", "this.requireSession(loginTarget, withinWriter)", "uncheckedSession(loginTarget)"],
  ["fleet scope", 'resource: { kind: "fleet" },', 'resource: { kind: "repository", repoId: "repo-a" },'],
  ["provider", "provider.authorize({", "provider.unchecked({"],
  ["session credential", "userAccessToken: session.accessToken,", "userAccessToken: forgedToken,"],
  ["denial", 'decision.outcome !== "allowed"', "false"],
]) {
  test(`G0-2 rejects access management after removing ${mutation[0]}`, (t) => {
    const root = hostSnapshot(t);
    assert.equal(auditDurableActionAuthorization(root, ["access-manage"]).rows[0].authorizationPort, true);
    mutate(root, "packages/authorization-keycloak/src/oidc-session-service.ts", mutation[1], mutation[2]);
    assert.equal(auditDurableActionAuthorization(root, ["access-manage"]).rows[0].authorizationPort, false);
  });
}
