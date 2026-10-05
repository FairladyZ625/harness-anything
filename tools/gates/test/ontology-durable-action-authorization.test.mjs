// harness-test-tier: fast
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditDurableActionAuthorization, main } from "../ontology-durable-action-authorization.mjs";
import { captureGate, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("G0-2 reports the base advisory and names an action whose AuthorizationPort call is removed", () => {
  assert.equal(captureGate(() => main(["--root", repoRoot])).code, 0);
  const rootDir = mkdtempSync(path.join(tmpdir(), "ontology-action-authorization-"));
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
  const root = mkdtempSync(path.join(tmpdir(), "ontology-host-authorization-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["packages/daemon/src", "packages/application/src"])
    cpSync(path.join(repoRoot, directory), path.join(root, directory), { recursive: true });
  const receipt = "packages/kernel/src/domain/receipt-domain-registry.ts";
  writeRepoFile(root, receipt, readFileSync(path.join(repoRoot, receipt), "utf8"));
  return root;
}

function mutate(root, name, before, after, unique = false) {
  const file = `packages/daemon/src/${name}.ts`,
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
    before: ").authorize({",
    after: ").unchecked({",
    missing: retiredHostKinds.filter((kind) => kind !== "rbac-bootstrap"),
  },
  {
    name: "center adapter authorization",
    file: "repo-cell-authorization",
    before: ").authorizePerson({",
    after: ").uncheckedPerson({",
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
    file: "oidc-session-service",
    before: 'throw coded("bootstrap_admin_closed", "The first Harness administrator already exists.");',
    after: "return { ok: true };",
    missing: ["rbac-bootstrap"],
  },
  {
    name: "bootstrap serialization",
    file: "oidc-session-service",
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

test("G0-2 traces all 141 declared writes, including queued task catalog ingress", () => {
  const result = auditDurableActionAuthorization(repoRoot);
  assert.equal(result.rows.length, 141); // dec_DBF9CCB96B1A7D35A3214615E1 CH2/CH6: handoff export, claim, and revoke.
  assert.deepEqual(result.findings, []);
  assert.ok(result.rows.every((row) => row.receiptAuthorizationDecision));
});

const queuedWriteMutations = [
  {
    name: "durable membership",
    file: "repo-cell-command-run",
    before: "(durablePolicyActions as readonly string[]).includes(action.kind)",
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
        file = `packages/kernel/src/domain/${registration ? "task-action-contract" : "action-declaration"}.ts`,
        source = readFileSync(path.join(root, file), "utf8"),
        before = registration ? `lifecycle("${kind}", {` : `closure("task-${kind}", "task/${kind}"),`,
        after = registration ? `disconnected("${kind}", {` : "";
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
    anchor = '  canonical("runtime-cancel", null, "repo-write"),',
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
