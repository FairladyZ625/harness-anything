#!/usr/bin/env node
// G-A durable-action authorization: every supported non-read protocol descriptor is traced from the
// daemon's transport entry to its effect. A row passes when an AuthorizationPort decision for the
// descriptor's own action kind exits on denial before the effect and nothing on the route runs the
// effect without it; a host command without such a decision must declare where its authority comes
// from (`hostAuthority`: the local transport, the operator's own process, or the acting person's
// own signed-in session), and that declaration is checked against the route, not trusted. A route
// that authorizes another kind than it declares (`kindRewrite`) is traced against that kind and holds
// only while its source decision and owner task are in the public evidence index and it has not expired.
import { hash } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { isMainThread, MessageChannel, parentPort, Worker, workerData } from "node:worker_threads";
import ts from "typescript";
import { shareAuthorizationTypes, readAuthorizationTypes } from "./authorization-shared-types.mjs";
import {
  authorizationShardBuckets,
  findingsFor,
  finishSourceRows,
  mergeAuthorizationProofs,
  partitionAuthorizationSources,
} from "./authorization-audit-shards.mjs";
import {
  authorizationCiRun,
  readAuthorizationShards,
  serializeAuthorizationShard,
} from "./authorization-ci-shards.mjs";
import {
  authorizationPolicyGraph,
  buildFlowGraph,
  freshEvaluationGraph,
  isFunctionNode,
  makeEvaluator,
  serverSourceGraph,
} from "./authorization-flow-graph.mjs";
import { makeAuthorizationTracer } from "./authorization-flow-trace.mjs";
import { processNativeSourceSites } from "./authorization-process-source-sites.mjs";
import { withArtifactActionIngressDeclarations } from "./ontology-gate-lib.mjs";
import {
  sourceFileOf,
  sourceSite,
  sourceWitnesses,
  intrinsicSupport,
  technicalPortEvidence,
  clientEntryProof,
  clientEntryRequiredRoutes,
  processOwnedOutput,
  repoReadServiceEvidence,
  delegatedServiceEntryEvidence,
  hostServiceEntryEvidence,
  hostServiceEntryRequired,
  migrationServiceEntryEvidence,
  processEntry,
  moduleEntry,
  processSourceSites,
  buildOutputWithinPackage,
  rootToolingSource,
  guiClientSource,
  guiCallbackCallerFiles,
} from "./authorization-source-proof.mjs";
import { EVIDENCE_INDEX } from "./evidence-index.mjs";
import { exitCodeFor, lineNumber, parseCommonArgs, parseTypeScript } from "./ontology-gate-lib.mjs";

const receiptPath = "packages/kernel/src/domain/receipt-domain-registry.ts";

/** Conservative module dependencies, including type imports, re-exports and literal import().
 * Unmapped/deleted production inputs and shared routing/proof infrastructure require a full cut.
 * No proof is cached: selected rows still run the unchanged authorization tracer.
 */
function productionFilesInScope(changedFiles) {
  if (!changedFiles) return null;
  const files = changedFiles.map((file) => path.posix.normalize(file.replaceAll("\\", "/")));
  if (
    files.some(
      (file) =>
        /^(?:packages\/kernel\/src\/|packages\/daemon\/src\/daemon-host\/protocol\/|tools\/gates\/)/u.test(file) ||
        /^(?:tools\/(?:gate-manifest\.json|run-manifest-gates\.mjs)|package(?:-lock)?\.json)$/u.test(file) ||
        /^packages\/daemon\/src\/daemon-host\/(?:repo-cell(?:-(?:open|api|command|action-context|action-dispatch|command-run|authorization))?|daemon-host-(?:open|context)|rpc-command-routing|daemon-operation)\.ts$/u.test(
          file,
        ) ||
        file.split("/").includes("..") ||
        path.posix.isAbsolute(file) ||
        // Non-source inputs can change module resolution, action declarations or script manifests.
        !/\.[cm]?[jt]sx?$|\.(?:md|html|css|svg|png)$/u.test(file),
    )
  )
    return null;
  return files.filter((file) => /\.[cm]?[jt]sx?$/u.test(file) && !/(?:\/test(?:s)?\/|\.(?:test|spec)\.)/u.test(file));
}

function pureNamedReexportMap(graph, file, sourceFile) {
  if (!sourceFile?.statements?.length) return null;
  const byName = new Map();
  for (const stmt of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(stmt) ||
      !stmt.moduleSpecifier ||
      !ts.isStringLiteralLike(stmt.moduleSpecifier) ||
      !stmt.exportClause ||
      !ts.isNamedExports(stmt.exportClause)
    )
      return null;
    const target = graph.importTarget({ file, from: stmt.moduleSpecifier.text }).file;
    for (const el of stmt.exportClause.elements)
      byName.set(el.name.text, { target: target ?? file, exported: (el.propertyName ?? el.name).text });
  }
  return byName;
}

function dynamicImportNamedMembers(sourceFile, node) {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const cast = node.parent && ts.isAsExpression(node.parent) ? node.parent.type : null;
  const promised =
    cast && ts.isTypeReferenceNode(cast) && cast.typeName.getText(sourceFile) === "Promise"
      ? cast.typeArguments?.[0]
      : null;
  if (!promised) return null;
  const members = ts.isTypeLiteralNode(promised)
    ? promised.members
    : ts.isTypeReferenceNode(promised) && ts.isIdentifier(promised.typeName)
      ? sourceFile.statements.find(
          (stmt) =>
            ts.isInterfaceDeclaration(stmt) && stmt.name.text === promised.typeName.text && !stmt.heritageClauses,
        )?.members
      : null;
  if (!members?.length) return null;
  const names = [];
  for (const member of members) {
    if (
      (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) ||
      !member.name ||
      (!ts.isIdentifier(member.name) && !ts.isStringLiteralLike(member.name))
    )
      return null;
    names.push(member.name.text);
  }
  return names;
}

export function changedAuthorizationScope(graph, inputs, changedFiles) {
  const full = { descriptorIds: null, sourceIds: null };
  const production = productionFilesInScope(changedFiles);
  if (!production) return full;
  if (production.length === 0) return { descriptorIds: new Set(), sourceIds: new Set() };
  if (production.some((file) => !graph.modules.has(file))) return full;
  const productionSet = new Set(production),
    barrels = new Map();
  for (const [file, { sourceFile }] of graph.modules) {
    const map = pureNamedReexportMap(graph, file, sourceFile);
    if (map) barrels.set(file, map);
  }
  const resolveBarrelTarget = (barrelFile, symbolName, seen = new Set()) => {
    if (productionSet.has(barrelFile) || seen.has(barrelFile)) return barrelFile;
    const entry = barrels.get(barrelFile)?.get(symbolName);
    if (!entry) return barrelFile;
    if (!barrels.has(entry.target)) return entry.target;
    seen.add(barrelFile);
    return resolveBarrelTarget(entry.target, entry.exported, seen);
  };
  const addReverse = (reverse, target, importer) => {
    if (!target) return;
    if (!reverse.has(target)) reverse.set(target, new Set());
    reverse.get(target).add(importer);
  };
  const reverse = new Map();
  for (const [file, { sourceFile }] of graph.modules) {
    (function visit(node) {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
              ? node.arguments[0]
              : null;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const target = graph.importTarget({ file, from: specifier.text }).file;
        const dynamicNames =
          target && barrels.has(target) && !productionSet.has(target)
            ? dynamicImportNamedMembers(sourceFile, node)
            : null;
        if (
          target &&
          barrels.has(target) &&
          !productionSet.has(target) &&
          ts.isImportDeclaration(node) &&
          node.importClause &&
          !node.importClause.name &&
          node.importClause.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)
        ) {
          for (const el of node.importClause.namedBindings.elements)
            addReverse(reverse, resolveBarrelTarget(target, (el.propertyName ?? el.name).text), file);
        } else if (dynamicNames) {
          for (const name of dynamicNames) addReverse(reverse, resolveBarrelTarget(target, name), file);
        } else {
          addReverse(reverse, target, file);
        }
      }
      ts.forEachChild(node, visit);
    })(sourceFile);
  }
  const affected = new Set(production),
    queue = [...affected];
  for (let index = 0; index < queue.length; index += 1)
    for (const importer of reverse.get(queue[index]) ?? [])
      if (!affected.has(importer)) {
        affected.add(importer);
        queue.push(importer);
      }
  const actions = inputs.constants.actionDeclarations ?? [],
    sourcesByKind = new Map(actions.map((action) => [action.kind, action.ontology?.sources ?? []])),
    routes = new Set(),
    kinds = new Set(),
    sourceIds = new Set(),
    affectedClientSources = [];
  for (const action of actions)
    for (const source of action.ontology?.sources ?? [])
      if (affected.has(sourceFileOf(source))) {
        sourceIds.add(source.candidateId);
        routes.add(source.route);
        kinds.add(action.kind);
        if (source.role === "client") affectedClientSources.push({ action, source });
      }
  if (production.length && sourceIds.size === 0) return full;
  if (affectedClientSources.length > 0 && typeof graph.fileOf === "function") {
    const clientWitnesses = sourceWitnesses(
      graph,
      affectedClientSources.map(({ source }) => source),
    );
    for (const { action, source } of affectedClientSources) {
      const node = clientWitnesses.get(source.candidateId);
      if (!node) continue;
      for (const route of clientEntryRequiredRoutes(graph, node, source, action, inputs.descriptors)) routes.add(route);
    }
  }
  const descriptorIds = new Set(
    inputs.descriptors
      .filter((descriptor) => {
        const kind = descriptor.kindRewrite?.authorizedKind ?? descriptor.actionKind ?? descriptor.id;
        const sources = sourcesByKind.get(kind) ?? [];
        return routes.has(descriptor.id) || kinds.has(kind) || (affected.size > 0 && sources.length === 0);
      })
      .map((descriptor) => descriptor.id),
  );
  for (const action of actions)
    for (const source of action.ontology?.sources ?? [])
      if (descriptorIds.has(source.route)) sourceIds.add(source.candidateId);
  return { descriptorIds, sourceIds };
}
const portAnchors = [
  { file: "packages/kernel/src/ports/authorization-port.ts", name: "AuthorizationPort" },
  { file: "packages/kernel/src/ports/identity-provider-port.ts", name: "AuthorizationDecisionPort" },
];

const decisionAnchor = { file: "packages/kernel/src/domain/receipt-frame.ts", name: "AuthorizationDecision" };
const sessionAnchors = [
  { file: "packages/kernel/src/ports/identity-session-port.ts", name: "IdentitySessionPort", member: "requireSession" },
];
const serviceAnchors = [
  {
    file: "packages/application/src/task-lifecycle-service.ts",
    name: "TaskLifecycleService",
    members: ["execute", "executeWithDocuments"],
  },
];

/** The protocol authorities the trace reads: descriptors, the method table and kernel constants. */
export async function loadAuthorizationInputs(rootDir) {
  const load = (file) => import(pathToFileURL(path.join(rootDir, file)).href);
  const actionDeclarationRelPath = "packages/kernel/src/domain/action-declaration.ts";
  const entityKindRelPath = "packages/kernel/src/domain/entity-kind-registry.ts";
  const [contract, commands, kernel, domainDeclarations, entityKinds] = await Promise.all([
    load("packages/daemon/src/daemon-host/protocol/daemon-protocol.contract.ts"),
    load("packages/daemon/src/daemon-host/protocol/daemon-protocol-commands.ts"),
    load("packages/kernel/src/index.ts"),
    fs.existsSync(path.join(rootDir, actionDeclarationRelPath)) ? load(actionDeclarationRelPath) : null,
    fs.existsSync(path.join(rootDir, entityKindRelPath)) ? load(entityKindRelPath) : null,
  ]);
  const constants = {},
    functions = {};
  for (const [name, value] of Object.entries(kernel))
    (typeof value === "function" ? functions : constants)[name] = value;
  const actionDeclarations = withArtifactActionIngressDeclarations(
    kernel.actionDeclarations ?? [],
    domainDeclarations?.artifactActionSourceDeclarations,
  );
  constants.actionDeclarations = actionDeclarations;
  constants.entityKindContracts = entityKinds?.entityKindContracts ?? [];
  const descriptors = [...contract.daemonProtocolCommands, ...contract.daemonActionRoutes].map((row) => ({
    ...row,
  }));
  // Native process effects share an entry declared by their local authority action. They are
  // source bindings, not protocol descriptors; business/client routes still require an exact
  // descriptor below. Keep this set derived from the same declarations so an arbitrary native
  // route cannot bypass the descriptor ownership check.
  const nativeEntryRoutes = new Set(
    actionDeclarations.flatMap((action) =>
      action.ontology?.authority ? Object.keys(action.ontology.entries ?? {}) : [],
    ),
  );
  for (const action of actionDeclarations) {
    if (action.ontology?.authority || action.executionClass === "repo-read") continue;
    for (const source of action.ontology?.sources ?? []) {
      if (source.role === "effect" && nativeEntryRoutes.has(source.route)) continue;
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

const transportEntriesCache = new WeakMap();

function transportEntries(graph) {
  if (graph.transportEntries) return graph.transportEntries();
  let entries = transportEntriesCache.get(graph.modules);
  if (!entries) {
    // A transport hands each decoded request to a function whose first parameter is the request.
    entries = [];
    for (const { sourceFile } of graph.modules.values())
      (function visit(node) {
        if (isFunctionNode(node) && node.parameters[0]?.type?.getText() === "JsonRpcRequest") entries.push(node);
        ts.forEachChild(node, visit);
      })(sourceFile);
    transportEntriesCache.set(graph.modules, entries);
  }
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

// Tests may request named source rows (an empty ID array requests owner proofs only).
// Keep the complete declarations as proof anchors; gate/CLI calls validate every source.
export function auditDurableActionAuthorization(rootDir, inputs, options = {}) {
  // Reuse source analysis only. Evaluator scopes are keyed by graph identity, so each
  // audit gets a fresh identity and an empty frame pool even when its AST is shared.
  if (!options.graph) return auditAuthorization(rootDir, inputs, options);
  const graph = freshEvaluationGraph(options.graph);
  try {
    return auditAuthorization(rootDir, inputs, { ...options, graph });
  } finally {
    graph.releaseQueries();
  }
}

function buildAuthorizationGraph(rootDir, sourceRoot, declaredSources, sourceActions, declaredActions) {
  const declaredSourceFiles = declaredSources.map(sourceFileOf);
  return buildFlowGraph(sourceRoot, {
    anchorRoot: rootDir,
    lexicalFiles: guiCallbackCallerFiles(
      sourceRoot,
      declaredSourceFiles.filter((f) => /^packages\/gui\/src\/(?:renderer|preload|browser|main)\//u.test(f)),
    ),
    sourceFiles: [
      ...new Set([
        ...declaredSourceFiles,
        ...sourceActions.flatMap((action) =>
          Object.values(action.ontology.entries ?? {}).flatMap((entry) => [
            entry.file,
            ...(entry.builder ? [entry.builder] : []),
          ]),
        ),
        ...declaredActions
          .filter((action) => action.ontology?.authority)
          .flatMap((action) =>
            Object.values(action.ontology.entries ?? {}).flatMap((entry) => [
              entry.file,
              ...(entry.builder ? [entry.builder] : []),
            ]),
          ),
      ]),
    ],
  });
}

function auditAuthorization(rootDir, inputs, options) {
  let stamp = performance.now();
  const elapsed = () => {
    const now = performance.now();
    const ms = Math.round(now - stamp);
    stamp = now;
    return ms;
  };
  const record = (label, data) => {
    if (options.profile) console.log("AUTH_PROFILE", JSON.stringify({ shard: options.shard, label, ...data }));
  };
  const preparedGraph = options.graph;
  const sourceProjection = options.sourceIds === undefined ? null : new Set(options.sourceIds);
  const { partition, shard, groupQueue } = options;
  const placement =
    partition && shard && !groupQueue
      ? { index: partition.index + partition.count * shard.index, count: partition.count * shard.count }
      : (partition ?? (groupQueue ? null : shard));
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const sourceRoot = options.sourceRoot ?? rootDir,
    durable = inputs.descriptors.filter((descriptor) => descriptor.commandClass !== "repo-read"),
    declaredActions = inputs.constants.actionDeclarations ?? [],
    onlySet = options.only ? new Set(options.only) : null,
    matchesOnly = (descriptor) =>
      !onlySet ||
      onlySet.has(descriptor.id) ||
      Boolean(descriptor.actionKind && onlySet.has(descriptor.actionKind)) ||
      Boolean(descriptor.kindRewrite?.authorizedKind && onlySet.has(descriptor.kindRewrite.authorizedKind)),
    selectedKinds = onlySet
      ? new Set([
          ...onlySet,
          ...inputs.descriptors
            .filter(matchesOnly)
            .flatMap((descriptor) => [
              descriptor.id,
              ...(descriptor.actionKind ? [descriptor.actionKind] : []),
              ...(descriptor.kindRewrite?.authorizedKind ? [descriptor.kindRewrite.authorizedKind] : []),
            ]),
        ])
      : null,
    actions = declaredActions.filter(
      (action) => action.ontology?.sources?.length && (!selectedKinds || selectedKinds.has(action.kind)),
    ),
    onlyActions = onlySet
      ? actions
          .map((action) => ({
            ...action,
            ontology: {
              ...action.ontology,
              sources: action.ontology.sources.filter(
                (source) => onlySet.has(action.kind) || onlySet.has(source.route),
              ),
            },
          }))
          .filter((action) => action.ontology.sources.length)
      : actions,
    buckets = (placement || groupQueue) && authorizationShardBuckets(actions, durable),
    sourceActions = placement ? partitionAuthorizationSources(onlyActions, buckets, placement) : onlyActions,
    includeAllSourcesForScope = (productionFilesInScope(options.changedFiles)?.length ?? 0) > 0,
    declaredSources = [
      ...new Set([
        ...sourceActions.flatMap((action) => action.ontology.sources),
        ...actions.flatMap((action) =>
          action.ontology.sources.filter(
            (s) =>
              includeAllSourcesForScope || (s.role !== "support" && s.role !== "technical-port" && s.role !== "client"),
          ),
        ),
      ]),
    ],
    graph =
      preparedGraph ??
      (options.inventoryOnly && !includeAllSourcesForScope
        ? null
        : buildAuthorizationGraph(rootDir, sourceRoot, declaredSources, sourceActions, declaredActions)),
    scope = options.scope ?? changedAuthorizationScope(graph, inputs, options.changedFiles);
  if (options.prepareOnly) return { graph, scope, witnesses: sourceWitnesses(graph, declaredSources) };
  const availableSources = sourceActions
    .map((action) => ({
      ...action,
      ontology: {
        ...action.ontology,
        sources: action.ontology.sources.filter(
          (source) =>
            (!scope.sourceIds || scope.sourceIds.has(source.candidateId)) &&
            (!sourceProjection || sourceProjection.has(source.candidateId)),
        ),
      },
    }))
    .filter((action) => action.ontology.sources.length);
  const selected = durable
    .map((descriptor, index) => ({ descriptor, index }))
    .filter(
      ({ descriptor }) =>
        matchesOnly(descriptor) &&
        (!scope.descriptorIds || scope.descriptorIds.has(descriptor.id)) &&
        (!placement || buckets.get(descriptor.id) % placement.count === placement.index),
    );
  const sourceOrder = new Map(onlyActions.flatMap((action) => action.ontology.sources).map((source, i) => [source, i]));
  if (options.inventoryOnly) {
    graph?.releaseQueries();
    return {
      routes: selected.map(({ descriptor, index }) => [index, descriptor.id]),
      sources: availableSources.flatMap((action) =>
        action.ontology.sources.map((source) => [
          sourceOrder.get(source),
          source.candidateId,
          action.kind,
          source.route,
        ]),
      ),
    };
  }
  record("graphAndScope", { ms: elapsed(), modules: graph.modules.size });
  const // Rows need their own witness. Descriptor traces also consult declared
    // effect and technical-port anchors outside this shard.
    witnesses = sourceWitnesses(graph, [
      ...availableSources.flatMap((action) => action.ontology.sources),
      ...actions.flatMap((action) =>
        action.ontology.sources.filter(
          (source) => source.role !== "support" && source.role !== "client" && source.role !== "script",
        ),
      ),
    ]),
    sourceTargets = (action, route) =>
      (action?.ontology?.sources ?? [])
        .filter(
          (source) =>
            source.role !== "support" &&
            source.role !== "technical-port" &&
            source.role !== "client" &&
            (!route || (source.role !== "script" && source.route === route)) &&
            witnesses.has(source.candidateId),
        )
        .map((source) => ({
          id: source.candidateId,
          route: source.route,
          role: source.role,
          site: sourceSite(graph, witnesses.get(source.candidateId)),
        })),
    sourceResults = new Map(),
    serverGraph = serverSourceGraph(graph),
    migrationEvidence = new Map(),
    migrationFor = (node, source, action) => {
      if (!node) return null;
      const key = source.candidateId ?? source.id;
      if (!migrationEvidence.has(key))
        migrationEvidence.set(key, migrationServiceEntryEvidence(serverGraph, node, source, action));
      return migrationEvidence.get(key);
    },
    anchors = {
      sourceGraph: serverGraph,
      ports: portAnchors,
      authorityModule: "@harness-anything/kernel",
      decision: decisionAnchor,
      currentCut: {
        file: "packages/kernel/src/ports/task-event-store.ts",
        name: "CanonicalEventStore",
        member: "readHead",
      },
      writerQueue: { file: "packages/daemon/src/daemon-host/repo-cell.ts", name: "chainRepoCellWrite" },
      writerFence: { file: "packages/kernel/src/domain/write-chain.contract.ts", name: "assertCurrentWriter" },
      sessions: sessionAnchors,
      services: serviceAnchors,
      entries: transportEntries(serverGraph),
      constants: inputs.constants,
      functions: inputs.functions,
      serviceCall: (node, kind, canonical) =>
        declaredCalls
          .get(witnesses.nodeKey ? witnesses.nodeKey(node) : node)
          ?.some(({ action, source }) =>
            canonical
              ? action.kind === kind && (source.role === "effect" || source.role === undefined)
              : Boolean(technicalPortEvidence(graph, node, source, action, inputs.descriptors)),
          ) ?? false,
    },
    tracer = makeAuthorizationTracer(authorizationPolicyGraph(graph), anchors),
    // Source ownership retains internal service guards as well as its actual callback frames.
    sourceTracer = makeAuthorizationTracer(serverGraph, anchors),
    // ActionDeclaration residency: a host- or runtime-local action is not decided at a canonical cut.
    nonCanonical = new Set(
      (inputs.constants.actionDeclarations ?? [])
        .filter((declaration) => ["host-local", "runtime-local"].includes(declaration.residency?.scope))
        .map((declaration) => declaration.kind),
    ),
    readMethods = new Set(
      inputs.descriptors.filter((descriptor) => descriptor.commandClass === "repo-read").map((entry) => entry.method),
    );
  const declaredCalls = new Map();
  for (const action of actions)
    for (const source of action.ontology.sources) {
      const node = witnesses.key ? witnesses.key(source.candidateId) : witnesses.get(source.candidateId);
      if (!node) continue;
      if (!declaredCalls.has(node)) declaredCalls.set(node, []);
      declaredCalls.get(node).push({ action, source });
    }
  record("witnessesAndSetup", { ms: elapsed() });
  function traceRow({ descriptor, index }) {
    const routeStart = performance.now();
    const rewrite = descriptor.kindRewrite,
      kind = rewrite?.authorizedKind ?? descriptor.actionKind ?? descriptor.id,
      action = actions.find((action) => action.kind === kind),
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
    const traceInput = {
      method: descriptor.method,
      kind,
      commandClass: descriptor.commandClass,
      fields: wireFields(descriptor, inputs.methods),
      localTransport: authority === "local-transport",
      ownSession: authority === "own-session",
      canonicalCut: !nonCanonical.has(kind),
    };
    const owner = tracer.traceDescriptor(traceInput);
    const ownerEnd = performance.now();
    graph.resetFramePool();
    const ownerEvidence =
      authority === "local-transport" ? owner.local : authority === "own-session" ? owner.session : owner.authorized;
    const targets = sourceTargets(action, descriptor.id).filter((source) => {
      if (sourceProjection && !sourceProjection.has(source.id)) return false;
      const node = witnesses.get(source.id);
      return !(hostServiceEntryRequired(serverGraph, node, action) || migrationFor(node, source, action));
    });
    const fullTrace =
      targets.length > 0 &&
      ownerEvidence.length > 0 &&
      declarationViolations.length === 0 &&
      owner.violations.length === 0
        ? sourceTracer.traceDescriptor({ ...traceInput, sources: targets })
        : null;
    if (fullTrace) {
      for (const source of fullTrace.sources.values()) sourceResults.set(source.id, source);
    }
    const remainingTargets = fullTrace
      ? targets.filter((target) => {
          const seen = fullTrace.sources.get(target.site);
          return !seen?.seen || !seen.ok;
        })
      : [];
    const policyTrace =
      remainingTargets.length > 0
        ? tracer.traceDescriptor({
            ...traceInput,
            sources: remainingTargets,
            sourceEvaluator: fullTrace.sourceEvaluator,
          })
        : null;
    if (policyTrace) {
      for (const source of policyTrace.sources.values()) sourceResults.set(source.id, source);
    }
    if (fullTrace || policyTrace) graph.resetFramePool();
    record("route", {
      id: descriptor.id,
      ownerMs: Math.round(ownerEnd - routeStart),
      ms: Math.round(performance.now() - routeStart),
    });
    const trace = policyTrace ?? owner;
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
  }
  let rows;
  let scopedSourceActions = availableSources;
  if (groupQueue) {
    const groups = new Map();
    for (const row of selected) {
      const group = buckets.get(row.descriptor.id);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(row);
    }
    const loads = new Map();
    for (const action of availableSources)
      for (const src of action.ontology.sources) {
        const group = buckets.get(src.route);
        loads.set(group, (loads.get(group) ?? 0) + 1);
      }
    const queue = [...groups].sort(([a], [b]) => (loads.get(b) ?? 0) - (loads.get(a) ?? 0) || a - b);
    const owned = new Set();
    rows = [];
    for (let turn = Atomics.add(groupQueue, 0, 1); turn < queue.length; turn = Atomics.add(groupQueue, 0, 1)) {
      if (Atomics.load(groupQueue, 1)) throw new Error("peer worker failed");
      const [group, descriptors] = queue[turn];
      owned.add(group);
      for (const item of descriptors) {
        try {
          rows.push(traceRow(item));
        } catch (error) {
          throw new Error(`authorization for ${item.descriptor.id}: ${error.stack ?? error}`);
        }
      }
    }
    rows.sort((a, b) => a.index - b.index);
    scopedSourceActions = availableSources.flatMap((action) => {
      const sources = action.ontology.sources.filter((src) => {
        const group = buckets.get(src.route);
        return groups.has(group)
          ? owned.has(group)
          : Math.floor(group / (partition?.count ?? 1)) % shard.count === shard.index;
      });
      return sources.length ? [{ ...action, ontology: { ...action.ontology, sources } }] : [];
    });
  } else rows = selected.map(traceRow);
  record("serverRoutes", { ms: elapsed() });
  const processEvaluator = makeEvaluator(graph, { constants: {}, functions: {}, strictMembers: true });
  const nativeSites = new Map(),
    targetsByRoute = new Map();
  for (const action of scopedSourceActions)
    for (const source of sourceTargets(action)) {
      if (source.role !== "effect") continue;
      if (!targetsByRoute.has(source.route)) targetsByRoute.set(source.route, []);
      targetsByRoute.get(source.route).push(source);
    }
  for (const action of declaredActions.filter((action) => action.ontology?.authority)) {
    const { authority, entries = {} } = action.ontology;
    for (const [route, entry] of Object.entries(entries)) {
      const routeTargets = targetsByRoute.get(route);
      if (!routeTargets) continue;
      const root = processEntry(graph, entry, authority);
      if (!root || action.residency.scope === "canonical" || action.receiptSettlement !== "none") continue;
      const cacheKey = `${entry.file}\u0000${route}`;
      if (!nativeSites.has(cacheKey)) {
        nativeSites.set(
          cacheKey,
          processNativeSourceSites(
            graph,
            root,
            processEvaluator,
            routeTargets.map((source) => source.site),
          ),
        );
      }
      const sites = nativeSites.get(cacheKey);
      for (const source of routeTargets)
        sourceResults.set(source.id, {
          id: source.id,
          seen: sites.has(source.site),
          ok: sites.has(source.site),
          evidence: sites.has(source.site) ? [`${entry.file}: package-owned operator entry reaches this source`] : [],
        });
    }
  }
  record("nativeEntries", { ms: elapsed() });
  for (const action of scopedSourceActions.filter((action) => action.ontology.scriptManifest)) {
    const { scriptManifest } = action.ontology;
    const parent = rows.find((row) => row.kind === action.kind && row.ok);
    if (!parent || action.catalogId !== "script-execution/run") continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, scriptManifest), "utf8"));
    const sites = new Set();
    const scriptTargets = sourceTargets(action).filter(
      (source) => action.ontology.sources.find((binding) => binding.candidateId === source.id)?.role === "script",
    );
    if (scriptTargets.length === 0) continue;
    for (const script of manifest.scripts ?? []) {
      const file = path.posix.normalize(path.posix.join(path.posix.dirname(scriptManifest), script.command));
      const root = moduleEntry(graph, file);
      if (root)
        for (const site of processSourceSites(graph, root, {
          evaluator: processEvaluator,
          targets: scriptTargets.map((source) => source.site),
          targetOnly: true,
        }))
          sites.add(site);
    }
    for (const source of scriptTargets)
      sourceResults.set(source.id, {
        id: source.id,
        seen: sites.has(source.site),
        ok: sites.has(source.site),
        evidence: [`${scriptManifest}: registered command reached from ${parent.id}'s authorized script boundary`],
      });
  }
  record("scriptEntries", { ms: elapsed() });
  const sourceProofs = scopedSourceActions.flatMap((action) =>
    action.ontology.sources.map((source) => {
      const node = witnesses.get(source.candidateId);
      const proof = source.role === "support" && node && intrinsicSupport(graph, node);
      const trace = sourceResults.get(source.candidateId);
      const port = node && technicalPortEvidence(graph, node, source, action, inputs.descriptors);
      const client = node && clientEntryProof(graph, node, source, action, inputs.descriptors);
      const descriptor = inputs.descriptors.find((row) => row.id === source.route),
        route = rows.find((row) => row.id === source.route),
        repoRead = node && repoReadServiceEvidence(serverGraph, node, source, action, inputs.descriptors),
        delegated =
          node &&
          delegatedServiceEntryEvidence(
            serverGraph,
            node,
            source,
            action,
            descriptor,
            route,
            trace,
            migrationFor(node, source, action),
          ),
        hostEntry = node && hostServiceEntryEvidence(serverGraph, node, source, action, route),
        hostRequired = node && hostServiceEntryRequired(serverGraph, node, action),
        traceProof = !hostRequired && trace?.seen && trace.ok;
      const output =
        node &&
        action.ontology.authority === "local-process" &&
        action.residency.scope === "host-local" &&
        action.residency.writer === "caller-process" &&
        processOwnedOutput(graph, node);
      const tooling = action.ontology.authority === "package-script" && node && rootToolingSource(graph, node);
      const within =
        action.ontology.authority !== "package-script" ||
        (node && (tooling ? Boolean(proof || port) : buildOutputWithinPackage(graph, node)));
      return {
        ordinal: sourceOrder.get(source),
        row: {
          id: source.candidateId,
          kind: action.kind,
          route: source.route,
          clientRoutes: client?.routes ?? [],
          isRead: action.executionClass === "repo-read",
        },
        authority: action.ontology.authority ?? "authorization-port",
        witnessed: Boolean(node),
        within,
        hostRequired,
        hostEntry,
        port,
        rawClient: client?.evidence,
        support: source.role === "support",
        proof: Boolean(proof),
        output: Boolean(output),
        repoRead,
        delegated,
        trace,
        traceProof,
        missing: !within
          ? tooling
            ? "root tooling source needs a typed technical port or intrinsic support"
            : "build output escapes package dist"
          : source.role === "client"
            ? node && guiClientSource(graph, node)
              ? "GUI client source needs a typed client port whose RPC/IPC route matches its declared action"
              : "root tooling client source needs a typed client port whose command/action argument matches its declared route"
            : "source has no verified owner/authority chain",
      };
    }),
  );
  record("sourceProofs", { ms: elapsed() });
  if (!preparedGraph) graph.releaseQueries();
  const part = { rows, sourceProofs };
  return options.partial ? part : finishAuthorizationAudit(rootDir, inputs, part);
}

const SHARD_WORKER_MEMORY_BUDGET_BYTES = 6 * 1024 ** 3;
const DEFAULT_SHARD_COUNT = 4;

export function shardWorkerCount(
  parallelism = availableParallelism(),
  memoryBytes = Math.min(totalmem(), process.constrainedMemory() || Infinity),
  concurrencyCap = authorizationAuditConcurrencyLimit(),
) {
  return Math.max(
    1,
    Math.min(
      DEFAULT_SHARD_COUNT,
      parallelism,
      Math.floor(memoryBytes / SHARD_WORKER_MEMORY_BUDGET_BYTES),
      concurrencyCap ?? Infinity,
    ),
  );
}

export function authorizationAuditConcurrencyLimit(env = process.env) {
  const raw = env.HARNESS_AUTH_AUDIT_CONCURRENCY;
  if (raw === undefined) return null;
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error("HARNESS_AUTH_AUDIT_CONCURRENCY must be a positive integer");
  }
  return Number(raw);
}

/** Each worker traces its partition, then exits to free its graph and heap. */
export async function shardedAudit(rootDir, changedFiles, options = {}) {
  const inputs = await loadAuthorizationInputs(rootDir);
  const proof = await auditAuthorizationPart(rootDir, inputs, changedFiles, options);
  return finishAuthorizationAudit(rootDir, inputs, proof);
}

export async function auditAuthorizationPart(rootDir, inputs, changedFiles, options = {}) {
  if (productionFilesInScope(changedFiles)?.length === 0) return { rows: [], sourceProofs: [] };
  const { sourceRoot, only, partition, shardCount, concurrency: requestedConcurrency } = options,
    workerBudget = shardWorkerCount(),
    slots = Math.max(1, Math.min(workerBudget, requestedConcurrency ?? workerBudget)),
    count = shardCount ?? slots,
    concurrency = Math.max(1, Math.min(count, slots)),
    shards = new Array(count),
    today = options.today ?? new Date().toISOString().slice(0, 10);
  const { graph, scope, witnesses } = auditAuthorization(rootDir, inputs, {
    sourceRoot,
    only,
    changedFiles,
    prepareOnly: true,
  });
  const owner = shareAuthorizationTypes(graph, transportEntries(serverSourceGraph(graph)), witnesses);
  const groupQueue = new Int32Array(new SharedArrayBuffer(8));
  let failed = false;
  let nextIndex = 0;
  async function runWorkerSlot() {
    while (!failed && nextIndex < count) {
      const index = nextIndex++;
      shards[index] = await new Promise((resolve, reject) => {
        let message;
        let hasMessage = false;
        const { port1, port2 } = new MessageChannel();
        const signal = new Int32Array(new SharedArrayBuffer(4));
        owner.serve(port1, signal, groupQueue);
        const worker = new Worker(new URL(import.meta.url), {
          transferList: [port2],
          workerData: {
            sharedTypes: { meta: owner.meta, port: port2, signal },
            durableAuthorizationShard: {
              groupQueue: count === concurrency ? groupQueue : null,
              profile: options.profile,
              rootDir,
              sourceRoot,
              only,
              partition,
              scope,
              today,
              shard: { index, count },
            },
          },
        });
        worker.once("message", (payload) => {
          message = payload;
          hasMessage = true;
        });
        worker.once("error", (error) => {
          failed = true;
          Atomics.store(groupQueue, 1, 1);
          reject(error);
        });
        worker.once("exit", (code) => {
          port1.close();
          if (code !== 0) reject(new Error(`authorization shard ${index} exited with ${code}`));
          else if (!hasMessage) reject(new Error(`authorization shard ${index} exited without result`));
          else resolve(message);
        });
      });
    }
  }
  try {
    const slots = await Promise.allSettled(Array.from({ length: concurrency }, runWorkerSlot));
    const aborted =
      slots.find((slot) => slot.status === "rejected" && !String(slot.reason).includes("peer worker failed")) ??
      slots.find((slot) => slot.status === "rejected");
    if (aborted) throw aborted.reason;
  } finally {
    graph.releaseQueries();
  }
  if (options.profile) console.log("SHARED_TYPES", Object.fromEntries(owner.counts));
  return mergeAuthorizationProofs(shards);
}

function finishAuthorizationAudit(rootDir, inputs, { rows, sourceProofs }) {
  const receipt = receiptAuthorizationContract(rootDir);
  const bindings = inputs.descriptors
    .filter((descriptor) => descriptor.commandClass !== "repo-read")
    .map(({ id, actionKind }) => [id, actionKind ?? id]);
  const sourceRows = finishSourceRows(sourceProofs, rows, bindings);
  return { rows, sourceRows, receipt, findings: findingsFor(rows, receipt, sourceRows) };
}

export function collectAuthorizationAudit(rootDir, inputs, run, options = {}) {
  const inventory = auditAuthorization(rootDir, inputs, { ...options, inventoryOnly: true });
  return finishAuthorizationAudit(rootDir, inputs, readAuthorizationShards(run, inventory));
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
    const changedIndex = argv.findIndex((arg) => arg === "--changed-files" || arg === "--changed-files-stdin");
    const fromStdin = argv[changedIndex] === "--changed-files-stdin";
    const changedFiles =
      changedIndex < 0 ? undefined : JSON.parse(fromStdin ? fs.readFileSync(0, "utf8") : argv[changedIndex + 1]);
    if (changedIndex >= 0 && (!Array.isArray(changedFiles) || changedFiles.some((file) => typeof file !== "string")))
      throw new Error("--changed-files requires a JSON array of paths");
    const { rootDir, mode } = parseCommonArgs(
      changedIndex < 0
        ? argv
        : argv.filter((_, index) => index !== changedIndex && (fromStdin || index !== changedIndex + 1)),
    );
    const started = Date.now();
    const run = authorizationCiRun(rootDir, changedFiles);
    const inputs = await loadAuthorizationInputs(rootDir);
    if (run?.mode === "shard") {
      const proof = await auditAuthorizationPart(rootDir, inputs, changedFiles, {
        partition: run.partition,
        today: run.stamp.today,
        profile: true,
      });
      console.log("AUTH_SHARD_PROOF", serializeAuthorizationShard(run, proof));
      console.log(
        "AUTH_SHARD_RESULT",
        JSON.stringify({
          ...run.partition,
          rows: proof.rows.length,
          sources: proof.sourceProofs.length,
          ms: Date.now() - started,
          peakRssKiB: process.resourceUsage().maxRSS,
          cpus: availableParallelism(),
          memoryBytes: Math.min(totalmem(), process.constrainedMemory() || Infinity),
        }),
      );
      return 0;
    }
    const result = run
      ? collectAuthorizationAudit(rootDir, inputs, run, { changedFiles })
      : finishAuthorizationAudit(
          rootDir,
          inputs,
          await auditAuthorizationPart(rootDir, inputs, changedFiles, { profile: true }),
        );
    console.log(
      "AUTH_RESULT",
      Object.fromEntries(Object.entries(result).map(([key, value]) => [key, hash("sha256", JSON.stringify(value))])),
    );
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
    console.log(`authorization audit peak RSS: ${process.resourceUsage().maxRSS} KiB`);
    console.log(`source authority: ${result.sourceRows.filter((row) => row.ok).length}/${result.sourceRows.length}`);
    for (const finding of result.findings) console.log(`- ${finding}`);
    for (const source of result.sourceRows)
      console.log(`${source.id} | ${source.authority} | ${source.ok ? source.evidence[0] : "MISSING"}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(
      `G0-2 ontology-durable-action-authorization: ${error instanceof Error ? error.stack : String(error)}`,
    );
    return 1;
  }
}

if (!isMainThread && workerData?.durableAuthorizationShard) {
  const { groupQueue, profile, rootDir, sourceRoot, only, shard, partition, scope, today } =
    workerData.durableAuthorizationShard;
  const start = performance.now();
  const inputs = await loadAuthorizationInputs(rootDir);
  if (profile) console.log("AUTH_INPUTS", JSON.stringify({ shard, ms: Math.round(performance.now() - start) }));
  const shared = readAuthorizationTypes(workerData.sharedTypes);
  const graph = buildFlowGraph(sourceRoot ?? rootDir, { shared });
  const proof = auditAuthorization(rootDir, inputs, {
    groupQueue,
    graph,
    profile,
    sourceRoot,
    only,
    shard,
    partition,
    scope,
    today,
    partial: true,
  });
  graph.releaseQueries();
  parentPort.postMessage(proof);
} else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode = await main();
