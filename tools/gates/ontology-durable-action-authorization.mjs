#!/usr/bin/env node
// G-A durable-action authorization: every supported non-read protocol descriptor is traced from the
// daemon's transport entry to its effect. A row passes when an AuthorizationPort decision for the
// descriptor's own action kind exits on denial before the effect and nothing on the route runs the
// effect without it; a host command without such a decision must declare where its authority comes
// from (`hostAuthority`: the local transport, the operator's own process, or the acting person's
// own signed-in session), and that declaration is checked against the route, not trusted. A route
// that authorizes another kind than it declares (`kindRewrite`) is traced against that kind and holds
// only while its source decision and owner task are in the public evidence index and it has not expired.
import { availableParallelism } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import ts from "typescript";
import { authorizationPolicyGraph, buildFlowGraph, isFunctionNode } from "./authorization-flow-graph.mjs";
import { makeAuthorizationTracer } from "./authorization-flow-trace.mjs";
import {
  sourceFileOf,
  sourceSite,
  sourceWitnesses,
  intrinsicSupport,
  processOwnedOutput,
  processEntry,
  moduleEntry,
  processSourceSites,
  buildOutputWithinPackage,
} from "./authorization-source-proof.mjs";
import { EVIDENCE_INDEX } from "./evidence-index.mjs";
import { exitCodeFor, lineNumber, parseCommonArgs, parseTypeScript } from "./ontology-gate-lib.mjs";

const receiptPath = "packages/kernel/src/domain/receipt-domain-registry.ts";
const portAnchors = [
  { file: "packages/kernel/src/ports/authorization-port.ts", name: "AuthorizationPort" },
  { file: "packages/kernel/src/ports/identity-provider-port.ts", name: "AuthorizationDecisionPort" },
];

const decisionAnchor = { file: "packages/kernel/src/domain/receipt-frame.ts", name: "AuthorizationDecision" };
const sessionAnchors = [
  { file: "packages/kernel/src/ports/identity-session-port.ts", name: "IdentitySessionPort", member: "requireSession" },
];

/** The protocol authorities the trace reads: descriptors, the method table and kernel constants. */
export async function loadAuthorizationInputs(rootDir) {
  const load = (file) => import(pathToFileURL(path.join(rootDir, file)).href);
  const [contract, commands, kernel] = await Promise.all([
    load("packages/daemon/src/protocol/daemon-protocol.contract.ts"),
    load("packages/daemon/src/protocol/daemon-protocol-commands.ts"),
    load("packages/kernel/src/index.ts"),
  ]);
  const constants = {},
    functions = {};
  for (const [name, value] of Object.entries(kernel))
    (typeof value === "function" ? functions : constants)[name] = value;
  const descriptors = [...contract.daemonProtocolCommands, ...contract.daemonGuiActionMethods].map((row) => ({
    ...row,
  }));
  for (const action of kernel.actionDeclarations) {
    if (action.ontology?.authority || action.executionClass === "repo-read") continue;
    for (const source of action.ontology?.sources ?? []) {
      const descriptor = descriptors.find((row) => row.id === source.route);
      if (!descriptor || (descriptor.actionKind ?? descriptor.id) !== action.kind)
        throw new Error(
          `${action.kind}: ontology source route ${source.route} does not resolve to its owning authorization descriptor`,
        );
    }
  }
  return {
    descriptors,
    methods: commands.daemonProtocolMethods,
    constants,
    functions,
  };
}

/**
 * The request fields a descriptor fixes on the wire: a command whose method declares a closed
 * `operation` vocabulary names its own id there.
 */
function wireFields(descriptor, methods) {
  const operation = methods.find((entry) => entry.method === descriptor.method)?.params?.fields?.operation;
  const vocabulary = Array.isArray(operation?.values) ? operation.values : Array.isArray(operation) ? operation : null;
  return vocabulary?.includes(descriptor.id) ? { operation: descriptor.id } : {};
}

function transportEntries(graph) {
  // A transport hands each decoded request to a function whose first parameter is the request.
  const entries = [];
  for (const { sourceFile } of graph.modules.values())
    (function visit(node) {
      if (isFunctionNode(node) && node.parameters[0]?.type?.getText() === "JsonRpcRequest") entries.push(node);
      ts.forEachChild(node, visit);
    })(sourceFile);
  return entries;
}

/** Why a kind-rewrite declaration cannot stand; empty when it cites indexed evidence and is unexpired. */
export function kindRewriteViolations(rewrite, today, index = EVIDENCE_INDEX) {
  const violations = [],
    decision = String(rewrite.sourceDecision ?? "").split("/")[0];
  if (typeof rewrite.authorizedKind !== "string" || rewrite.authorizedKind === "")
    violations.push("kindRewrite names no authorizedKind");
  if (!index.decisions.includes(decision))
    violations.push(`kindRewrite source decision ${rewrite.sourceDecision} is not in the evidence index`);
  if (!index.tasks.includes(rewrite.ownerTask))
    violations.push(`kindRewrite owner task ${rewrite.ownerTask} is not in the evidence index`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rewrite.expires ?? "") || Number.isNaN(Date.parse(rewrite.expires)))
    violations.push(`kindRewrite expiry ${rewrite.expires} is not a YYYY-MM-DD date`);
  else if (today > rewrite.expires)
    violations.push(`kindRewrite expired on ${rewrite.expires} (${rewrite.sourceDecision}, ${rewrite.ownerTask})`);
  return violations;
}

export function auditDurableActionAuthorization(rootDir, inputs, options = {}) {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const sourceRoot = options.sourceRoot ?? rootDir,
    actions = (inputs.constants.actionDeclarations ?? []).filter(
      (action) => action.ontology?.sources?.length && (!options.only || options.only.includes(action.kind)),
    ),
    declaredSources = actions.flatMap((action) => action.ontology.sources),
    graph = buildFlowGraph(sourceRoot, {
      anchorRoot: rootDir,
      sourceFiles: [
        ...new Set([
          ...declaredSources.map(sourceFileOf),
          ...actions.flatMap((action) =>
            Object.values(action.ontology.entries ?? {}).flatMap((entry) => [
              entry.file,
              ...(entry.builder ? [entry.builder] : []),
            ]),
          ),
        ]),
      ],
    }),
    witnesses = sourceWitnesses(graph, declaredSources),
    sourceTargets = (action, route) =>
      (action?.ontology?.sources ?? [])
        .filter(
          (source) =>
            source.role !== "support" &&
            (!route || (source.role !== "script" && source.route === route)) &&
            witnesses.has(source.candidateId),
        )
        .map((source) => ({
          id: source.candidateId,
          route: source.route,
          site: sourceSite(graph, witnesses.get(source.candidateId)),
        })),
    sourceResults = new Map(),
    tracer = makeAuthorizationTracer(authorizationPolicyGraph(graph), {
      sourceGraph: graph,
      ports: portAnchors,
      authorityModule: "@harness-anything/kernel",
      decision: decisionAnchor,
      sessions: sessionAnchors,
      entries: transportEntries(graph),
      constants: inputs.constants,
      functions: inputs.functions,
    }),
    // ActionDeclaration residency: a host- or runtime-local action is not decided at a canonical cut.
    nonCanonical = new Set(
      (inputs.constants.actionDeclarations ?? [])
        .filter((declaration) => ["host-local", "runtime-local"].includes(declaration.residency?.scope))
        .map((declaration) => declaration.kind),
    ),
    durable = inputs.descriptors.filter((descriptor) => descriptor.commandClass !== "repo-read"),
    readMethods = new Set(
      inputs.descriptors.filter((descriptor) => descriptor.commandClass === "repo-read").map((entry) => entry.method),
    ),
    selected = durable
      .map((descriptor, index) => ({ descriptor, index }))
      .filter(
        ({ descriptor, index }) =>
          (!options.only || options.only.includes(descriptor.id)) &&
          (!options.shard || index % options.shard.count === options.shard.index),
      );
  const sourceActions = actions.filter((action, index) => {
    const owner = durable.findIndex((descriptor) => (descriptor.actionKind ?? descriptor.id) === action.kind);
    return !options.shard || (owner < 0 ? durable.length + index : owner) % options.shard.count === options.shard.index;
  });
  const rows = selected.map(({ descriptor, index }) => {
    const rewrite = descriptor.kindRewrite,
      kind = rewrite?.authorizedKind ?? descriptor.actionKind ?? descriptor.id,
      authority = descriptor.hostAuthority ?? (rewrite ? "kind-rewrite" : "authorization-port"),
      declarationViolations = rewrite ? kindRewriteViolations(rewrite, today) : [];
    if (authority === "local-process")
      return {
        index,
        id: descriptor.id,
        kind,
        method: descriptor.method,
        authority,
        ok: readMethods.has(descriptor.method),
        evidence: readMethods.has(descriptor.method)
          ? [`${descriptor.method} also serves a repo-read command; the daemon performs no write for it`]
          : [`${descriptor.method} is not a read method, so the daemon may act for this command`],
        violations: [],
      };
    const trace = tracer.traceDescriptor({
      method: descriptor.method,
      kind,
      commandClass: descriptor.commandClass,
      fields: wireFields(descriptor, inputs.methods),
      localTransport: authority === "local-transport",
      ownSession: authority === "own-session",
      canonicalCut: !nonCanonical.has(kind),
      sources: sourceTargets(
        actions.find((action) => action.kind === kind),
        descriptor.id,
      ),
    });
    for (const source of trace.sources.values()) sourceResults.set(source.id, source);
    const evidence =
        authority === "local-transport" ? trace.local : authority === "own-session" ? trace.session : trace.authorized,
      violations = [...declarationViolations, ...trace.violations];
    return {
      index,
      id: descriptor.id,
      kind,
      method: descriptor.method,
      authority,
      ok: evidence.length > 0 && violations.length === 0,
      evidence,
      violations,
    };
  });
  const nativeSites = new Map();
  for (const action of sourceActions.filter((action) => action.ontology.authority)) {
    const { authority, entries = {} } = action.ontology;
    const targets = sourceTargets(action);
    for (const [route, entry] of Object.entries(entries)) {
      const root = processEntry(graph, entry, authority);
      if (!root || action.residency.scope === "canonical" || action.receiptSettlement !== "none") continue;
      if (!nativeSites.has(entry.file)) nativeSites.set(entry.file, processSourceSites(graph, root));
      const sites = nativeSites.get(entry.file);
      for (const source of targets.filter((source) => source.route === route))
        sourceResults.set(source.id, {
          id: source.id,
          seen: sites.has(source.site),
          ok: sites.has(source.site),
          evidence: sites.has(source.site) ? [`${entry.file}: package-owned operator entry reaches this source`] : [],
        });
    }
  }
  for (const action of sourceActions.filter((action) => action.ontology.scriptManifest)) {
    const { scriptManifest } = action.ontology;
    const parent = rows.find((row) => row.kind === action.kind && row.ok);
    if (!parent || action.catalogId !== "script-execution/run") continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, scriptManifest), "utf8"));
    const sites = new Set();
    for (const script of manifest.scripts ?? []) {
      const file = path.posix.normalize(path.posix.join(path.posix.dirname(scriptManifest), script.command));
      const root = moduleEntry(graph, file);
      if (root) for (const site of processSourceSites(graph, root)) sites.add(site);
    }
    for (const source of sourceTargets(action).filter(
      (source) => action.ontology.sources.find((binding) => binding.candidateId === source.id)?.role === "script",
    ))
      sourceResults.set(source.id, {
        id: source.id,
        seen: sites.has(source.site),
        ok: sites.has(source.site),
        evidence: [`${scriptManifest}: registered command reached from ${parent.id}'s authorized script boundary`],
      });
  }
  const sourceRows = sourceActions.flatMap((action) =>
    action.ontology.sources.map((source) => {
      const node = witnesses.get(source.candidateId);
      const proof = source.role === "support" && node && intrinsicSupport(graph, node);
      const trace = sourceResults.get(source.candidateId);
      const output =
        node &&
        action.ontology.authority === "local-process" &&
        action.residency.scope === "host-local" &&
        action.residency.writer === "caller-process" &&
        processOwnedOutput(graph, node);
      const within = action.ontology.authority !== "package-script" || (node && buildOutputWithinPackage(graph, node));
      const ok = Boolean(node && within && (proof || output || (trace?.seen && trace.ok)));
      return {
        id: source.candidateId,
        kind: action.kind,
        authority:
          source.role === "support"
            ? "intrinsic-support"
            : output
              ? "process-stdio"
              : (action.ontology.authority ?? "authorization-port"),
        ok,
        evidence: proof
          ? ["typed process-local intrinsic; no external effect"]
          : output
            ? ["Node process-owned stdout/stderr; caller-process residency"]
            : (trace?.evidence ?? []),
        violations: ok
          ? []
          : [!within ? "build output escapes package dist" : "source has no verified owner/authority chain"],
      };
    }),
  );
  const receipt = receiptAuthorizationContract(rootDir);
  return {
    rows,
    sourceRows,
    receipt,
    findings: [
      ...findingsFor(rows, receipt),
      ...sourceRows.filter((source) => !source.ok).map((source) => `${source.id}: ${source.violations.join("; ")}`),
    ],
  };
}

function findingsFor(rows, receipt) {
  return [
    ...rows
      .filter((row) => !row.ok)
      .map((row) =>
        row.violations.length > 0
          ? `${row.id} (${row.kind}): ${row.violations.join("; ")}`
          : `${row.id} (${row.kind}): no ${row.authority} authority dominates the effect of ${row.method}`,
      ),
    ...(receipt.nonNullable
      ? []
      : [`${receipt.file}:${receipt.line} receipt.authorizationDecision is optional or nullable`]),
  ];
}

/** Each worker builds its own graph and traces every count-th descriptor; rows merge in order. */
async function shardedAudit(rootDir) {
  const count = Math.max(1, Math.min(4, availableParallelism())),
    shards = await Promise.all(
      Array.from(
        { length: count },
        (_, index) =>
          new Promise((resolve, reject) => {
            const worker = new Worker(new URL(import.meta.url), {
              workerData: { durableAuthorizationShard: { rootDir, shard: { index, count } } },
            });
            worker.once("message", resolve);
            worker.once("error", reject);
            worker.once("exit", (code) => {
              if (code !== 0) reject(new Error(`authorization shard ${index} exited with ${code}`));
            });
          }),
      ),
    ),
    rows = shards.flatMap((shard) => shard.rows).sort((left, right) => left.index - right.index),
    receipt = shards[0].receipt,
    sourceRows = shards.flatMap((shard) => shard.sourceRows);
  return {
    rows,
    sourceRows,
    receipt,
    findings: [
      ...findingsFor(rows, receipt),
      ...sourceRows.filter((source) => !source.ok).map((source) => `${source.id}: ${source.violations.join("; ")}`),
    ],
  };
}

function receiptAuthorizationContract(rootDir) {
  const sourceFile = parseTypeScript(rootDir, receiptPath);
  let member = null;
  (function visit(node) {
    if (!member && ts.isInterfaceDeclaration(node) && node.name.text === "WriteReceipt") {
      member = node.members.find(
        (candidate) =>
          ts.isPropertySignature(candidate) &&
          (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
          candidate.name.text === "authorizationDecision",
      );
      return;
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  if (!member) return { file: receiptPath, line: 1, nonNullable: false };
  return {
    file: receiptPath,
    line: lineNumber(sourceFile, member.getStart(sourceFile)),
    nonNullable: !member.questionToken && member.type !== undefined && !typeContainsNullish(member.type),
  };
}

function typeContainsNullish(node) {
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (typeContainsNullish(child)) found = true;
  });
  return found;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode } = parseCommonArgs(argv);
    const started = Date.now();
    const result = await shardedAudit(rootDir);
    console.log(`G0-2 ontology-durable-action-authorization: ${mode}`);
    console.log("command | action | authority | evidence");
    for (const row of result.rows)
      console.log(`${row.id} | ${row.kind} | ${row.authority} | ${row.ok ? row.evidence[0] : "MISSING"}`);
    console.log(
      `unproven authorization routes: ${result.rows.filter((row) => !row.ok).length}/${result.rows.length} ` +
        `(${Date.now() - started}ms)`,
    );
    console.log(
      `receipt contract: ${result.receipt.file}:${result.receipt.line} ${result.receipt.nonNullable ? "non-null" : "optional/null"}`,
    );
    console.log(`source authority: ${result.sourceRows.filter((row) => row.ok).length}/${result.sourceRows.length}`);
    for (const source of result.sourceRows)
      console.log(`${source.id} | ${source.authority} | ${source.ok ? source.evidence[0] : "MISSING"}`);
    for (const finding of result.findings) console.log(`- ${finding}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(
      `G0-2 ontology-durable-action-authorization: ${error instanceof Error ? error.stack : String(error)}`,
    );
    return 1;
  }
}

if (!isMainThread && workerData?.durableAuthorizationShard) {
  const { rootDir, shard } = workerData.durableAuthorizationShard;
  const { rows, sourceRows, receipt } = auditDurableActionAuthorization(
    rootDir,
    await loadAuthorizationInputs(rootDir),
    {
      shard,
    },
  );
  parentPort.postMessage({ rows, sourceRows, receipt });
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode = await main();
