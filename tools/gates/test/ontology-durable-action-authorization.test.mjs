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

function mutate(root, name, before, after) {
  const file = `packages/daemon/src/${name}.ts`,
    source = readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");
  assert.ok(source.includes(before), `mutation anchor missing in ${name}: ${before}`);
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

test("G0-2 traces all 138 declared writes, including queued task catalog ingress", () => {
  const result = auditDurableActionAuthorization(repoRoot);
  assert.equal(result.rows.length, 138); // dec_CDDCFA8BB91A47BCE07B229E93 CH2: assign and unassign.
  assert.deepEqual(result.findings, []);
  assert.ok(result.rows.every((row) => row.receiptAuthorizationDecision));
});

for (const mutation of [
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
    before: "const revision = context.store.readHead()?.revision ?? 0,",
    after: "const revision = 0,",
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
]) {
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
