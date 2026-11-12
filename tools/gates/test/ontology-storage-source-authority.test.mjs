// harness-test-tier: contract
import assert from "node:assert/strict";
import { realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { auditOntologyClosure } from "../ontology-closure-audit.mjs";
import { scanOntologyText } from "../ontology-closure-scan.mjs";
import { auditDurableActionAuthorization } from "../ontology-durable-action-authorization.mjs";
import { makeRepo } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const file = "packages/storage/src/driver.ts";
const source = `/// <reference types="node" />
import type { StatementSync } from "node:sqlite";
import "../../kernel/src/ports/authorization-port.ts";
import "../../kernel/src/ports/identity-provider-port.ts";
import "../../kernel/src/ports/identity-session-port.ts";
export function persist(statement: StatementSync) { statement.run(); }
export function bypass() { const writer = { run() {} }; writer.run(); }
export function undeclared(statement: StatementSync) { statement.run(); }`;
const candidates = scanOntologyText(file, source).filter((row) => row.category === "action");
const port = "node_modules/@types/node/sqlite.d.ts#node:sqlite.StatementSync.run";
const binding = (symbol) => ({
  candidateId: candidates.find((row) => row.symbol === symbol).id,
  route: "storage-io",
  role: "technical-port",
  port,
});
function fixture() {
  const { rootDir } = makeRepo({
    [file]: source,
    "packages/kernel/src/ports/authorization-port.ts": "export interface AuthorizationPort { authorize(): void; }",
    "packages/kernel/src/ports/identity-provider-port.ts":
      "export interface AuthorizationDecisionPort { authorize(): void; }",
    "packages/kernel/src/ports/identity-session-port.ts":
      "export interface IdentitySessionPort { requireSession(): void; }",
    "packages/kernel/src/domain/receipt-domain-registry.ts":
      "export interface WriteReceipt { authorizationDecision: object; }",
  });
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  return rootDir;
}
const action = (sources) => ({
  kind: "storage-io",
  receiptSettlement: "none",
  residency: { scope: "canonical", writer: "center-repo-cell" },
  ontology: { owner: "storage", technical: true, authority: "local-process", sources },
});
const inputs = (sources) => ({
  descriptors: [],
  methods: [],
  functions: {},
  constants: { actionDeclarations: [action(sources)] },
});

test("a declared SQLite technical port passes G-A without claiming a remote command permission", () => {
  const result = auditDurableActionAuthorization(fixture(), inputs([binding("persist")]));
  assert.deepEqual(result.findings, []);
  assert.equal(result.sourceRows[0].ok, true);
  assert.match(result.sourceRows[0].evidence.join(" "), /typed technical port/u);
});

test("the same-shaped storage domain bypass cannot borrow the proven SQLite port", () => {
  const result = auditDurableActionAuthorization(fixture(), inputs([binding("bypass")]));
  assert.equal(result.sourceRows[0].ok, false);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0], /no verified owner\/authority chain/u);
});

test("closure still rejects undeclared storage writes, including calls to the real driver", () => {
  const result = auditOntologyClosure({
    candidates,
    baseline: [],
    previous: [],
    snapshot: { actions: [action([binding("persist")])], kinds: [] },
  });
  assert.deepEqual(result.findings.map((row) => row.symbol).sort(), ["bypass", "undeclared"]);
  assert.ok(result.findings.every((row) => row.code === "ONTOLOGY_ACTION_UNDECLARED"));
});
