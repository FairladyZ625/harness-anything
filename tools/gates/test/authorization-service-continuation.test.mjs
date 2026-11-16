// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { authorizationPolicyGraph, buildFlowGraph } from "../authorization-flow-graph.mjs";
import { makeAuthorizationTracer } from "../authorization-flow-trace.mjs";
import { sourceSite } from "../authorization-source-proof.mjs";
import { makeRepo } from "./helpers.mjs";

function continuation(mutation = "", policyBoundary = false, routedKind = "task-rework") {
  const file = "packages/daemon/src/continuation.ts",
    contracts = "packages/kernel/src/ports/contracts.ts";
  const { rootDir } = makeRepo({
    "packages/storage/src/bridge.ts": "export function bridge(work) { return work(); }",
    [contracts]: `export interface AuthorizationDecision { outcome: "allowed" | "denied"; actor: unknown; evaluatedAtCut: string }
export interface AuthorizationPort { authorize(input: unknown, context: unknown): AuthorizationDecision }
export interface CanonicalEventStore { readHead(): { revision: number } | null }`,
    [file]: `import type { AuthorizationDecision, AuthorizationPort, CanonicalEventStore } from "../../kernel/src/ports/contracts.ts";
import { bridge } from "../../storage/src/bridge.ts";
declare const port: AuthorizationPort, store: CanonicalEventStore;
declare function overlay(): Record<string, unknown>;
const fake = { authorize: () => ({ outcome: "allowed" }) };
function decide(input) { return ${mutation === "replaced port" ? "fake" : "port"}.authorize(input, { evaluatedAtCut: \`canonical:\${input.revision}\` }); }
function required(binding) {
  ${mutation === "bypassed guard" ? "" : 'if (!binding.authorizationDecision || binding.authorizationDecision.outcome !== "allowed") throw new Error("denied");'}
  return binding.authorizationDecision;
}
function proofFor(command, binding) {
  if (command.type === "CreateTask" || command.type === "CreateReplayTask") return { actorBinding: command.actor };
  if (command.type === "ReworkTask") {
    const decision = required(binding);
    return { actorBinding: ${mutation === "wrong proof actor" ? '{ principal: { personId: "forged" }, executor: null }' : "command.actor"}, authorizationDecision: ${mutation === "replaced proof decision" ? '{ outcome: "allowed" }' : "decision"} ${mutation === "opaque proof overlay" ? ", ...overlay()" : ""} };
  }
  if (command.type !== "CompleteTask") throw new Error("unsupported command");
  return { authorizationDecision: required(binding) };
}
function envelope(input) { return Object.freeze({ actor: input.actor }); }
function normalize(binding, intent) { return Object.freeze({ ...intent, ...envelope({ ...binding, intent }) }); }
function withMeta(command) { return { ...command, publication: "current" ${mutation === "opaque command overlay" ? ", ...overlay()" : ""} }; }
function projectActor(actor) { const projected = globalThis.projectActor(actor); return projected; }
const context = { proofFor: (command, snapshot, binding) => proofFor(command, binding) };
const service = { execute(command, proof) { return { outcome: "applied", proof }; } };
export function writerFence() {}
export function queue(request, execute: (decision?: AuthorizationDecision) => unknown) {
  const decision = port.authorize({ kind: request.kind, actor: request.actor }, { evaluatedAtCut: "outer" });
  if (decision.outcome === "denied") return;
  ${mutation === "missing writer fence" ? "" : "writerFence();"}
  ${mutation === "uninvoked callback" ? "return;" : "execute(decision);"}
}
function entry(request) {
  const owner = request.owner;
  const work = () => {
    const command = withMeta(normalize({ actor: ${mutation === "opaque actor caller" ? "projectActor(owner)" : "owner"} }, { type: "ReworkTask" }));
    ${mutation === "an earlier unguarded effect" ? "service.execute(command, {});" : ""}
    const binding = { actor: ${mutation === "opaque actor caller" ? "projectActor(request.reviewer)" : mutation === "wrong actor" ? "request.reviewer" : "owner"} };
    const decision = decide({ action: { kind: ${mutation === "wrong kind" ? '"task-review-execution"' : '"task-rework"'} }, binding, revision: ${mutation === "stale cut" ? "0" : "store.readHead()?.revision ?? 0"} });
    ${mutation === "mutated command" ? "command.actor = request.reviewer;" : ""}
    const proof = context.proofFor(command, {}, { ...binding, authorizationDecision: decision });
    ${mutation === "unreachable service" ? "if (false) " : ""}return service.execute(command, ${mutation === "detached proof" ? "{}" : "proof"});
  };
  return ${mutation === "cross-package bridge" ? "bridge(() => " : ""}queue(request, ${mutation === "detached callback" ? "() => undefined" : "work"})${mutation === "cross-package bridge" ? ")" : ""};
}`,
  });
  const graph = buildFlowGraph(rootDir),
    statements = graph.modules.get(file).sourceFile.statements,
    entry = statements.at(-1);
  const effects = [];
  (function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText() === "service.execute") effects.push(node);
    ts.forEachChild(node, visit);
  })(entry);
  return makeAuthorizationTracer(policyBoundary ? authorizationPolicyGraph(graph) : graph, {
    sourceGraph: graph,
    ports: [{ file: contracts, name: "AuthorizationPort" }],
    decision: { file: contracts, name: "AuthorizationDecision" },
    currentCut: { file: contracts, name: "CanonicalEventStore", member: "readHead" },
    writerQueue: mutation === "outside the writer turn" ? undefined : { file, name: "queue" },
    writerFence: { file, name: "writerFence" },
    serviceCall: (node, kind) =>
      mutation !== "unregistered service" && kind === "task-rework" && effects.includes(node),
    entries: [entry],
    constants: {
      actionDeclarations: [{ kind: "task-rework" }, { kind: "task-review-execution" }],
      entityKindContracts: [
        {
          actionCatalog: {
            actions: [{ execution: { ingress: "task-rework", lifecycle: { commandType: "ReworkTask" } } }],
          },
        },
      ],
    },
    functions: {},
  }).traceDescriptor({
    method: "demo",
    kind: routedKind,
    commandClass: "repo-write",
    canonicalCut: true,
    sources: effects.map((effect, index) => ({ id: `canonical service ${index}`, site: sourceSite(graph, effect) })),
  });
}

// dec_7E44897ECDCAEF2B92EC66A260/CH1, CEO Option 2: the callback obtains its
// own current-cut Port decision for its command's actor, then enforces and spends that proof.
test("an invoked service continuation independently authorizes its own canonical command", () => {
  const result = continuation();
  assert.deepEqual(result.violations, []);
  assert.equal(
    [...result.sources.values()].every((row) => row.seen && row.ok),
    true,
    JSON.stringify({ ...result, sources: [...result.sources] }),
  );
});

test("a typed package boundary preserves the service's independent denial exit", () => {
  // A policy-only graph sees reachability but drops the package's internal guards.
  const incomplete = continuation("cross-package bridge", true);
  assert.equal(
    [...incomplete.sources.values()].every((row) => row.seen && row.ok),
    false,
  );
  const result = continuation("cross-package bridge");
  assert.deepEqual(result.violations, []);
  assert.equal(
    [...result.sources.values()].every((row) => row.seen && row.ok),
    true,
    JSON.stringify({ ...result, sources: [...result.sources] }),
  );
});

test("an independent canonical service discharges its callback without borrowing the outer action kind", () => {
  const result = continuation("", false, "task-review-execution");
  assert.deepEqual(result.violations, []);
  // Its valid task-rework proof cannot certify a task-review-execution source.
  assert.equal(
    [...result.sources.values()].every((row) => row.seen && row.ok),
    false,
  );
});

test("an unreachable service invocation cannot discharge the callback's decision requirement", () => {
  const result = continuation("unreachable service");
  assert.ok(result.violations.some((violation) => violation.includes("without the authorization decision")));
});

for (const mutation of [
  "replaced port",
  "wrong kind",
  "wrong actor",
  "stale cut",
  "bypassed guard",
  "replaced proof decision",
  "detached proof",
  "detached callback",
  "uninvoked callback",
  "an earlier unguarded effect",
  "missing writer fence",
  "outside the writer turn",
  "wrong proof actor",
  "mutated command",
  "opaque command overlay",
  "opaque proof overlay",
  "opaque actor caller",
  "unregistered service",
])
  test(`a service continuation rejects ${mutation}`, () => {
    const result = continuation(mutation);
    assert.equal(
      result.violations.length === 0 && [...result.sources.values()].every((row) => row.seen && row.ok),
      false,
    );
  });
