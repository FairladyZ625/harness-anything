// Minimal typed authorization/source fixture. No production tree is copied or executed.
import assert from "node:assert/strict";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import { auditDurableActionAuthorization } from "../ontology-durable-action-authorization.mjs";
import { scanOntologyText } from "../ontology-closure-scan.mjs";
import { makeRepo } from "./helpers.mjs";

export function sourceWitness(_t, placement) {
  const file = "packages/daemon/src/source.ts",
    decision = "packages/kernel/src/domain/receipt-frame.ts",
    authorization = "packages/kernel/src/ports/authorization-port.ts",
    effect = 'writeFileSync("/tmp/source-proof-fixture", "test");',
    denial = 'if (authorizationDecision.outcome === "denied") return;',
    files = {
      [decision]: 'export interface AuthorizationDecision { outcome: "allowed" | "denied" }',
      [authorization]: `import type { AuthorizationDecision } from "../domain/receipt-frame.ts";
export interface AuthorizationPort { authorize(input: unknown, context: unknown): AuthorizationDecision }`,
      "packages/kernel/src/ports/identity-provider-port.ts": "export interface AuthorizationDecisionPort {}",
      "packages/kernel/src/ports/identity-session-port.ts":
        "export interface IdentitySessionPort { requireSession(): unknown }",
      "packages/application/src/task-lifecycle-service.ts":
        "export interface TaskLifecycleService { execute(): unknown; executeWithDocuments(): unknown }",
      "packages/kernel/src/domain/receipt-domain-registry.ts": `import type { AuthorizationDecision } from "./receipt-frame.ts";
export interface WriteReceipt { authorizationDecision: AuthorizationDecision }`,
      "packages/kernel/src/ports/task-event-store.ts":
        "export interface CanonicalEventStore { readHead(): { revision: number } | null }",
      "packages/kernel/src/domain/write-chain.contract.ts": "export function assertCurrentWriter() {}",
      "packages/daemon/src/daemon-host/repo-cell.ts":
        "export function chainRepoCellWrite(work: () => unknown) { return work(); }",
      [file]: `import { writeFileSync, appendFileSync } from "node:fs";
import type { AuthorizationPort } from "../../kernel/src/ports/authorization-port.ts";
import type { CanonicalEventStore } from "../../kernel/src/ports/task-event-store.ts";
import { assertCurrentWriter } from "../../kernel/src/domain/write-chain.contract.ts";
import { chainRepoCellWrite } from "./daemon-host/repo-cell.ts";
declare const port: AuthorizationPort, store: CanonicalEventStore;
type JsonRpcRequest = { method: string };
export function entry(request: JsonRpcRequest) {
  if (request.method !== "source.write") return;
  return chainRepoCellWrite(() => {
  assertCurrentWriter();
  const revision = store.readHead()?.revision ?? 0;
  const authorizationDecision = port.authorize({ kind: "fixture-write", request, revision }, { evaluatedAtCut: \`canonical:\${revision}\` });
  ${placement === "before" ? effect : ""}
  ${denial}
  ${placement === "after" ? effect : ""}
  appendFileSync("/tmp/source-owner-fixture", "owner");
  });
}
${placement === "detached" ? `function detachedSource() { ${effect} }` : ""}`,
    },
    { rootDir } = makeRepo(files),
    candidates = scanOntologyText(file, files[file]).filter(
      (row) => row.category === "action" && ["writeFileSync", "appendFileSync"].includes(row.name),
    ),
    candidate = candidates.find((row) => row.name === "writeFileSync");
  assert.ok(candidate);
  const localInputs = {
    descriptors: [{ id: "fixture-write", method: "source.write", commandClass: "repo-write" }],
    methods: [],
    functions: {},
    constants: {
      actionDeclarations: [
        {
          kind: "fixture-write",
          executionClass: "repo-write",
          residency: { scope: "canonical" },
          ontology: {
            sources: candidates.map((row) => ({ candidateId: row.id, route: "fixture-write", role: "effect" })),
          },
        },
      ],
    },
  };
  const result = auditDurableActionAuthorization(rootDir, localInputs, {
    graph: buildFlowGraph(rootDir, { sourceFiles: Object.keys(files) }),
  });
  if (placement === "detached") assert.equal(result.rows[0]?.ok, true, "the real owner still has authority");
  return result.sourceRows?.find((row) => row.id === candidate.id);
}
