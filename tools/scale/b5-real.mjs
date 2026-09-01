#!/usr/bin/env node

/**
 * B5 real-path measurement: builds a canonical event ledger from the scale
 * fixture's entity counts, replays it through the REAL task projection cold
 * catch-up (batching, blob prefetch, drain — the same code the daemon runs),
 * and then measures the daemon's real read model (task snapshot list, triadic
 * relation graph, Fact FTS search) — unparameterized, narrow, and paged.
 *
 * The old B5 proxy scanned authored fixture files; this replaces it per the
 * task contract: fix the proxy to measure the real thing. Standalone usage:
 *
 *   node tools/scale/b5-real.mjs --events 10000 [--rounds 2] \
 *     [--json-out path] [--markdown-out path] [--digest-only]
 *
 * `--digest-only` prints the sha256 of the serialized unparameterized results
 * so the same fixture can prove result-set equivalence across code changes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeBaselineReadModel } from "./b5-real-baseline.mjs";
import { markdown } from "./b5-real-markdown.mjs";

function parseArgs(argv) {
  const result = {
    fixture: null,
    rounds: 2,
    jsonOut: null,
    markdownOut: null,
    reportFile: null,
    digestOnly: false,
    entities: null,
    events: null,
    seed: "plt-scale-w1",
    sourceRoot: resolve(import.meta.dirname, "../.."),
    baselineRoot: null,
    label: "head",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[++index];
    if (key === "--fixture") result.fixture = value;
    else if (key === "--entities") result.entities = Number(value);
    else if (key === "--events") result.events = Number(value);
    else if (key === "--seed") result.seed = value;
    else if (key === "--rounds") result.rounds = Number(value);
    else if (key === "--json-out") result.jsonOut = value;
    else if (key === "--markdown-out") result.markdownOut = value;
    else if (key === "--report-file") result.reportFile = value;
    else if (key === "--source-root") result.sourceRoot = resolve(value);
    else if (key === "--baseline-root") result.baselineRoot = resolve(value);
    else if (key === "--label") result.label = value;
    else if (key === "--digest-only") result.digestOnly = true;
    else throw new Error(`Unknown option: ${key}`);
  }
  if ([result.fixture !== null, result.entities !== null, result.events !== null].filter(Boolean).length !== 1)
    throw new Error("exactly one of --fixture, --entities, or --events is required");
  if (result.events !== null && (!Number.isInteger(result.events) || result.events < 100))
    throw new Error("--events must be an integer of at least 100");
  if (!Number.isInteger(result.rounds) || result.rounds < 1) throw new Error("--rounds must be a positive integer");
  return result;
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return {
    count: values.length,
    minMs: at(0),
    p50Ms: at(50),
    p95Ms: at(95),
    maxMs: at(100),
    meanMs: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

function loadSnapshot() {
  const loads = loadavg();
  return {
    load1: Number(loads[0].toFixed(2)),
    load5: Number(loads[1].toFixed(2)),
    cpuCount: cpus().length,
    parallelism: availableParallelism(),
    freeMemoryMb: Number((freemem() / 1024 / 1024).toFixed(1)),
    totalMemoryMb: Number((totalmem() / 1024 / 1024).toFixed(1)),
  };
}

function rng(seed) {
  let state = 0;
  for (const char of String(seed)) state = Math.imul(state ^ char.codePointAt(0), 16777619) >>> 0 || 1;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 7), 61 | state) ^ state;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (value, width = 6) => String(value).padStart(width, "0");

async function measureB5RealSingle(options) {
  const importSource = (relativePath) => import(pathToFileURL(join(options.sourceRoot, relativePath)).href);
  const kernel = await importSource("packages/kernel/src/index.ts");
  const { makeTaskProjection } = await importSource("packages/kernel/src/projection/rebuildable-task-projection.ts");
  const relationGraphProjection = await importSource("packages/kernel/src/projection/relation-graph-projection.ts");
  const daemonQueryModule = await importSource("packages/daemon/src/task-query-read.ts").catch(() => null);
  const daemonActionModule = await importSource("packages/daemon/src/entity-action-catalog-executor.ts").catch(
    () => null,
  );
  const metadata =
    options.events !== null
      ? {
          seed: options.seed,
          primaryTaskCount: Math.max(1, Math.floor(options.events / 4)),
          factCount: Math.max(1, Math.round((options.events / 4) * 0.45)),
          decisionCount: Math.max(1, Math.round((options.events / 4) * 0.48)),
          targetEventCount: options.events,
        }
      : options.entities !== null
        ? {
            seed: options.seed,
            primaryTaskCount: options.entities,
            factCount: Math.max(1, Math.round(options.entities * 0.45)),
            decisionCount: Math.max(1, Math.round(options.entities * 0.48)),
            targetEventCount: null,
          }
        : JSON.parse(readFileSync(join(options.fixture, "fixture-metadata.json"), "utf8"));
  const rootDir = resolve(join(options.fixture ?? "tmp/scale-fixtures", `b5-real-ledger-${options.label}`));
  if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });

  const actor = { principal: { personId: "scale-fixture" }, executor: null };
  const random = rng(`${metadata.seed}:b5-real`);
  const statuses = ["planned", "active", "active", "done", "blocked"];
  const events = [];
  const blobs = new Map();
  let revision = 0;
  const taskIds = [];
  const taskSnapshots = new Map();

  const envelope = (taskId, type, payload, occurredAt) => {
    revision += 1;
    const event = {
      schema: "task-event/v1",
      eventId: `event-${pad(revision, 10)}`,
      workspaceRevision: revision,
      opId: `op-b5-${pad(revision, 10)}`,
      taskId,
      type,
      actor,
      source: "local",
      occurredAt,
      payload,
    };
    events.push(event);
    return event;
  };

  const loadBefore = loadSnapshot(),
    buildStarted = performance.now();
  const packagePaths = new Map();
  for (let index = 0; index < metadata.primaryTaskCount; index += 1) {
    const taskId = `task_scale_${pad(index)}`;
    taskIds.push(taskId);
    const title = `Synthetic workload ${pad(index)} with a realistic task title`;
    packagePaths.set(taskId, `tasks/${taskId}-${kernel.slugifyTaskTitle(title)}`);
    const task = {
      schema: "task/v2",
      taskId,
      title,
      taskClass: "standard",
      status: "planned",
      graph: kernel.REPLAY_TASK_GRAPH,
      currentNode: "implementation",
      iteration: 0,
      createdBy: actor,
      completionGateIds: [],
      presetSnapshotDigest: null,
      pinned: false,
      metadata: {
        idempotencyKey: null,
        parentTaskId: index ? `task_scale_${pad(Math.max(0, index - 1 - Math.floor(random() * 5)))}` : null,
        workKind: ["feat", "fix", "refactor", "docs", "test", "chore"][Math.floor(random() * 6)],
        riskTier: ["low", "medium", "high"][Math.floor(random() * 3)],
        urgency: ["low", "medium", "high"][Math.floor(random() * 3)],
        verticalId: "software/coding",
        presetId: "baseline",
        profileId: "baseline",
        moduleKey: `module-${Math.floor(random() * 24)}`,
        slug: `synthetic-workload-${pad(index)}`,
        surfaces: ["repo"],
        fromLegacyId: null,
      },
    };
    const occurredAt = new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString();
    envelope(taskId, "task_created", { task }, occurredAt);
    const status = statuses[Math.floor(random() * statuses.length)];
    let currentTask = task;
    if (status !== "planned") {
      currentTask = { ...task, status };
      envelope(
        taskId,
        "task_transitioned",
        {
          task: currentTask,
          mutation: { command: "transition", reason: "fixture status", fields: ["status"] },
          documentClaims: [],
        },
        occurredAt,
      );
    }
    if (index % 3 === 0 && index + 1 < metadata.primaryTaskCount) {
      const basis = {
        source: `task/${taskId}`,
        target: `task/task_scale_${pad(index + 1)}`,
        type: "depends-on",
        direction: "directed",
      };
      const relation = {
        relation_id: kernel.deriveRelationId(basis),
        ...basis,
        strength: "strong",
        origin: "declared",
        rationale: "fixture dependency edge",
        state: "active",
      };
      currentTask = { ...currentTask, relations: [relation] };
      envelope(
        taskId,
        "task_relation_added",
        {
          task: currentTask,
          mutation: { command: "relate", reason: relation.rationale, fields: [relation.relation_id] },
          documentClaims: [],
        },
        occurredAt,
      );
    }
    taskSnapshots.set(taskId, currentTask);
  }

  for (let index = 0; index < metadata.decisionCount; index += 1) {
    const decisionId = `dec_SCALE_${pad(index)}`,
      taskId = taskIds[index % taskIds.length],
      claimBasis = {
        source: `decision/${decisionId}/C1`,
        target: `task/${taskId}`,
        type: "derives",
        direction: "directed",
      },
      occurredAt = new Date(Date.UTC(2026, 0, 1) + 720_000 + index * 3_600_000).toISOString(),
      decisionRevision = revision + 1;
    const draft = {
      schema: "decision-event/v1",
      eventId: `event-${pad(decisionRevision, 10)}`,
      workspaceRevision: decisionRevision,
      opId: `op-b5-${pad(decisionRevision, 10)}`,
      decisionId,
      type: "decision_proposed",
      actor,
      source: "local",
      occurredAt,
      payload: {
        title: `Scale decision ${pad(index)}`,
        question: `How should synthetic workload ${pad(index)} be handled?`,
        riskTier: "medium",
        urgency: "low",
        vertical: "software/coding",
        preset: "baseline",
        appliesTo: { modules: [`module-${Math.floor(random() * 24)}`], productLines: ["coding"] },
        decisionClass: "ordinary",
        chosen: [{ id: "CH1", text: `Proceed with option one for ${pad(index)}` }],
        rejected: [{ id: "RJ1", text: "Do nothing", whyNot: "Workload requires handling" }],
        body: `\n# Scale decision ${pad(index)}\n\nRationale prose for the synthetic decision record.\n`,
        claims: [{ id: "C1", text: `Claim that workload ${pad(index)} stays index-friendly`, loadBearing: true }],
        fulfillments: [],
        relations: [
          {
            relation_id: kernel.deriveRelationId(claimBasis),
            ...claimBasis,
            strength: "strong",
            origin: "declared",
            rationale: "fixture decision-to-task edge",
            state: "active",
          },
        ],
      },
    };
    const bundle = kernel.compileDecisionWrite({
      event: draft,
      currentDecision: null,
      currentRelations: [],
      currentDocument: null,
    });
    revision = decisionRevision;
    events.push(bundle.event);
    blobs.set(bundle.event.payload.decisionDocumentClaim.sha256, Buffer.from(bundle.blobs[0].body, "utf8"));
  }

  // Fact events compile with the real compiler against the same per-task record
  // list the projection would return, then ride the same batch cold catch-up as
  // the task and decision events. (Compiling+applying them one-by-one through
  // projection.apply would trigger the per-write state-digest refresh — real
  // daemon behavior per write, but quadratic for a fixture build.)
  const factStatements = [];
  const factsByTask = new Map();
  for (let index = 0; index < metadata.factCount; index += 1) {
    const taskId = taskIds[index % taskIds.length],
      occurredAt = new Date(Date.UTC(2026, 0, 15) + index * 3_600_000).toISOString(),
      factRevision = revision + 1;
    const statement = `Synthetic observation token${index} for workload ${taskId} recorded by the fixture`;
    factStatements.push(`token${index}`);
    const draft = {
      schema: "fact-event/v1",
      eventId: `event-${pad(factRevision, 10)}`,
      workspaceRevision: factRevision,
      opId: `op-b5-${pad(factRevision, 10)}`,
      taskId,
      factId: `F-${createHash("sha256").update(`fact-${index}`).digest("hex").slice(0, 8).toUpperCase()}`,
      type: "fact_recorded",
      actor,
      source: "local",
      occurredAt,
      payload: {
        statement,
        evidenceSource: `scale-fixture/${taskId}`,
        observedAt: occurredAt,
        confidence: ["low", "medium", "high"][index % 3],
        memoryClass: ["semantic", "episodic", "procedural"][index % 3],
        memoryTags: ["abstract_rule"],
        provenance: [{ runtime: "human", sessionId: "scale-fixture", boundAt: occurredAt }],
      },
    };
    const currentFacts = factsByTask.get(taskId) ?? [];
    const bundle = kernel.compileFactWrite({ event: draft, packagePath: packagePaths.get(taskId), currentFacts });
    revision = factRevision;
    events.push(bundle.event);
    blobs.set(bundle.event.payload.factsDocumentClaim.sha256, Buffer.from(bundle.blobs[0].body, "utf8"));
    factsByTask.set(taskId, [
      ...currentFacts,
      {
        factId: bundle.event.factId,
        statement,
        evidenceSource: bundle.event.payload.evidenceSource,
        observedAt: occurredAt,
        confidence: bundle.event.payload.confidence,
        state: "standing",
        workspaceRevision: revision,
      },
    ]);
  }

  // --events is the explicit scale contract: top up with replay-safe task
  // observations so the canonical ledger contains exactly the requested 1e4 or
  // 1e5 events. Entity-ratio fixtures retain their historical task-count mode.
  if (metadata.targetEventCount !== null && metadata.targetEventCount !== undefined) {
    if (events.length > metadata.targetEventCount)
      throw new Error(
        `entity mix already exceeds requested event count (${events.length} > ${metadata.targetEventCount})`,
      );
    for (let index = 0; events.length < metadata.targetEventCount; index += 1) {
      const taskId = taskIds[index % taskIds.length],
        task = taskSnapshots.get(taskId),
        occurredAt = new Date(Date.UTC(2026, 1, 1) + events.length * 1_000).toISOString();
      envelope(
        taskId,
        "task_transitioned",
        {
          task,
          mutation: { command: "transition", reason: "scale event-count filler", fields: [] },
          documentClaims: [],
        },
        occurredAt,
      );
    }
  }

  const ledgerBuiltMs = performance.now() - buildStarted;
  const projectionStarted = performance.now();
  const eventStore = {
    readHead: () =>
      events.length === 0
        ? null
        : {
            revision: events.length,
            eventDigest: `sha256:${createHash("sha256")
              .update(kernel.serializeCanonicalEvent(events.at(-1)))
              .digest("hex")}`,
          },
    readBatch: (cursor, maxItems) => {
      const start = cursor === null ? 0 : Number(cursor),
        slice = events.slice(start, start + maxItems);
      return {
        sourceRevision: events.length,
        events: slice,
        cursor: start + slice.length >= events.length ? null : String(start + slice.length),
        done: start + slice.length >= events.length,
        accessedItems: slice.length,
        prefetchContent: (batch) =>
          new Map(
            batch
              .map((event) => contentClaimOf(event))
              .filter((sha256) => blobs.has(sha256))
              .map((sha256) => [sha256, blobs.get(sha256)]),
          ),
      };
    },
    readContentBlob: (sha256) => blobs.get(sha256) ?? null,
  };
  // Scale runs use a larger bounded catch-up window to keep the measurement
  // wall-clock finite at 1e4/1e5. Older comparison revisions only accept 64,
  // so preserve their admitted ceiling while using the current bounded window.
  let projection;
  try {
    projection = makeTaskProjection({ rootDir, eventStore, catchUpLimit: 4096 });
  } catch (error) {
    if (!(error instanceof Error) || !/catch-up limit/u.test(error.message)) throw error;
    projection = makeTaskProjection({ rootDir, eventStore, catchUpLimit: 64 });
  }
  // Drive the catch-up with the cheap progress probe: each round drains a bounded
  // batch, and a full list() per round would itself be an O(rounds x rows) scan.
  let reads = 0;
  while (projection.readProgress(taskIds[0]).status !== "ready" && reads < events.length / 64 + 16) reads += 1;
  if (projection.readProgress(taskIds[0]).status !== "ready")
    throw new Error(`cold catch-up did not reach ready after ${events.length} events`);
  const catchUpMs = performance.now() - projectionStarted,
    buildMs = performance.now() - buildStarted;

  const readModel = daemonQueryModule?.makeTaskQueryReadModel
    ? daemonQueryModule.makeTaskQueryReadModel({
        rootDir,
        projection,
        judgments: { closeout: kernel.closeoutReadiness, blocking: kernel.blockingOf },
      })
    : makeBaselineReadModel({ rootDir, projection, kernel, relationGraphProjection });
  const catalogActions = daemonActionModule?.makeEntityActionCatalogExecutor({
    store: eventStore,
    projection,
    now: () => "2026-12-31T00:00:00.000Z",
  });
  const narrowSupported = typeof projection.readRelationQuery === "function";
  const windowStart = new Date(Date.UTC(2026, 0, 10)).toISOString();

  const unparamTask = () => readModel.guiTasks();
  const unparamGraph = () => readModel.relationGraph();
  const factRead = (action) => {
    if (!catalogActions) return projection.searchFacts(action);
    const receipt = catalogActions.run(
      { kind: "fact-search", ...action },
      { actor, source: "local" },
      "read:b5-fact-search",
    );
    return JSON.parse(String(receipt.evidence));
  };
  const factQuery = (index) => factRead({ query: factStatements[index % factStatements.length] });
  const narrowStatus = () => readModel.guiTasks({ status: "active", limit: 50 });
  const narrowWindow = () => readModel.guiTasks({ updatedAfter: windowStart, limit: 50 });
  // A paged API is a served page, not an implicit N/page full export. The
  // integration suite separately proves that following every cursor exactly
  // reconstructs the unparameterized result; this scale sample measures the
  // actual first-page latency clients pay.
  const pageTask = () => readModel.guiTasks({ limit: 50 }).rows.length;
  const pageGraph = () => {
    if (!narrowSupported) return null;
    return readModel.relationGraphPage({ limit: 50 }).edges.length;
  };
  const pageFacts = () => factRead({ limit: 50 }).facts.length;

  const samples = {
    taskList: [],
    factSearch: [],
    relationGraph: [],
    taskStatus: [],
    taskWindow: [],
    taskPage: [],
    graphPage: [],
    factPage: [],
  };
  const sentinel = { taskRows: 0, factRows: 0, edges: 0 };
  for (let round = 0; round < options.rounds; round += 1) {
    for (let index = 0; index < 10; index += 1) {
      let started = performance.now();
      sentinel.taskRows = unparamTask().rows.length;
      samples.taskList.push(performance.now() - started);
      started = performance.now();
      sentinel.factRows = factQuery(index).facts.length;
      samples.factSearch.push(performance.now() - started);
      started = performance.now();
      sentinel.edges = unparamGraph().edges.length;
      samples.relationGraph.push(performance.now() - started);
      if (narrowSupported) {
        started = performance.now();
        narrowStatus();
        samples.taskStatus.push(performance.now() - started);
        started = performance.now();
        narrowWindow();
        samples.taskWindow.push(performance.now() - started);
        started = performance.now();
        pageTask();
        samples.taskPage.push(performance.now() - started);
        started = performance.now();
        pageGraph();
        samples.graphPage.push(performance.now() - started);
        started = performance.now();
        pageFacts();
        samples.factPage.push(performance.now() - started);
      }
    }
  }
  const unparameterizedBytes = {
    tasks: JSON.stringify(unparamTask()),
    graph: JSON.stringify(unparamGraph()),
    factSearch: JSON.stringify(factQuery(0)),
    factsAll: JSON.stringify(factRead({})),
  };
  const resultDigests = Object.fromEntries(
    Object.entries(unparameterizedBytes).map(([name, bytes]) => [
      name,
      createHash("sha256").update(bytes).digest("hex"),
    ]),
  );
  const digest = createHash("sha256").update(JSON.stringify(unparameterizedBytes)).digest("hex");
  const loadAfter = loadSnapshot();
  const result = {
    schema: "b5-real/v1",
    fixture: options.fixture ?? (options.events === null ? `entities:${options.entities}` : `events:${options.events}`),
    metadata,
    measurementContext: {
      measuredAt: new Date().toISOString(),
      sourceRoot: options.sourceRoot,
      label: options.label,
      loadBefore,
      loadAfter,
    },
    ledger: {
      events: events.length,
      tasks: metadata.primaryTaskCount,
      facts: metadata.factCount,
      decisions: metadata.decisionCount,
      buildMs: Number(buildMs.toFixed(1)),
      ledgerBuildMs: Number(ledgerBuiltMs.toFixed(1)),
      catchUpMs: Number(catchUpMs.toFixed(1)),
      catchUpReads: reads,
      narrowSupported,
    },
    sentinel,
    measurements: {
      taskList: stats(samples.taskList),
      factSearch: stats(samples.factSearch),
      relationGraph: stats(samples.relationGraph),
      ...(narrowSupported
        ? {
            taskStatusNarrow: stats(samples.taskStatus),
            taskWindowNarrow: stats(samples.taskWindow),
            taskPageFirst: stats(samples.taskPage),
            graphPageFirst: stats(samples.graphPage),
            factPageFirst: stats(samples.factPage),
          }
        : {}),
    },
    unparameterizedResultDigest: digest,
    unparameterizedResultDigests: resultDigests,
    unparameterizedResultBytes: Object.fromEntries(
      Object.entries(unparameterizedBytes).map(([name, bytes]) => [name, Buffer.byteLength(bytes)]),
    ),
  };
  projection.close();
  return result;
}

export async function measureB5Real(options) {
  if (!options.baselineRoot) return measureB5RealSingle(options);
  const baseline = await measureB5RealSingle({
    ...options,
    sourceRoot: options.baselineRoot,
    baselineRoot: null,
    label: "baseline",
  });
  const current = await measureB5RealSingle(options);
  const queryNames = [...new Set([...Object.keys(current.measurements), ...Object.keys(baseline.measurements)])];
  const queryP95 = Object.fromEntries(
    queryNames.map((name) => {
      const head = current.measurements[name]?.p95Ms ?? null,
        base = baseline.measurements[name]?.p95Ms ?? null;
      return [
        name,
        {
          baselineP95Ms: base,
          headP95Ms: head,
          deltaMs: base !== null && head !== null ? head - base : null,
          speedup: base !== null && head !== null && head > 0 ? base / head : null,
        },
      ];
    }),
  );
  const resultSetEqual = Object.fromEntries(
    Object.keys(current.unparameterizedResultDigests).map((name) => [
      name,
      current.unparameterizedResultDigests[name] === baseline.unparameterizedResultDigests[name],
    ]),
  );
  if (!resultSetEqual.tasks || !resultSetEqual.graph)
    throw new Error(`unparameterized task/graph bytes differ from baseline: ${JSON.stringify(resultSetEqual)}`);
  return {
    ...current,
    comparison: {
      baselineSourceRoot: options.baselineRoot,
      baselineDigest: baseline.unparameterizedResultDigest,
      digestEqual: current.unparameterizedResultDigest === baseline.unparameterizedResultDigest,
      baselineResultDigests: baseline.unparameterizedResultDigests,
      resultSetEqual,
      baselineLedger: baseline.ledger,
      queryP95,
    },
  };
}

function contentClaimOf(event) {
  if (event.schema === "decision-event/v1") return event.payload.decisionDocumentClaim?.sha256 ?? null;
  if (event.schema === "fact-event/v1") return event.payload.factsDocumentClaim?.sha256 ?? null;
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await measureB5Real(options);
  if (options.digestOnly) {
    console.log(report.unparameterizedResultDigest);
    return;
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.jsonOut) {
    mkdirSync(resolve(options.jsonOut, ".."), { recursive: true });
    writeFileSync(resolve(options.jsonOut), json);
  }
  const reportPath = options.reportFile ?? options.markdownOut;
  if (reportPath) {
    mkdirSync(resolve(reportPath, ".."), { recursive: true });
    writeFileSync(resolve(reportPath), `${markdown(report)}\n`);
  }
  console.log(options.jsonOut || reportPath ? `Wrote ${options.jsonOut ?? reportPath}` : json);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
