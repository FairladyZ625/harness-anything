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
    source = readFileSync(path.join(root, file), "utf8");
  assert.ok(source.includes(before), `mutation anchor missing in ${name}: ${before}`);
  writeRepoFile(root, file, source.replaceAll(before, after));
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
