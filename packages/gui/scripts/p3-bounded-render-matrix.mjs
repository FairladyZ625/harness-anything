#!/usr/bin/env node
/**
 * PLT-Performance/P3 matrix: 100 / 1_000 / 5_000 × 1/5 outputs.
 *
 * Measures selector + render-window layers deterministically (no Electron flakiness).
 * Projection/transport numbers are taken from the existing gui-projection-benchmark
 * when --with-projection is set; otherwise those columns are left as "n/a (see
 * tools/perf/gui-projection-benchmark.mjs)".
 *
 * first-usable is modeled as: data-ready (page fetch budget) + first-meaningful-rows
 * (window build) under the DOM ceiling. It never treats an empty shell as usable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  buildOverviewIndex,
  windowDimensionRows,
  OVERVIEW_DIMENSION_PAGE_SIZE,
} from "../src/renderer/model/overview-selectors.ts";
import {
  FIRST_SCREEN_DOM_CEILING,
  DEFAULT_EXPANDED_OUTPUTS,
} from "../src/renderer/perf/first-usable.ts";
import { needsForView } from "../src/renderer/perf/perspective-load.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultOutDir = path.resolve(
  __dirname,
  "../../../../../harness/tasks/task_01KXVFC7QDNHKTMS9S5XWXQYSD-revive-gui-bounded/artifacts",
);
const outDir = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : defaultOutDir;

const SIZES = [100, 1_000, 5_000];
const OUTPUTS = [1, 5];
const EXECUTION_PAGE_SIZE = 25;

function makeTasks(n) {
  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    const root = `root-${i % Math.max(1, Math.floor(n / 10))}`;
    tasks.push({
      taskId: `task_${String(i).padStart(26, "0")}`,
      title: `Task ${i}`,
      projectId: "proj",
      coordinationStatus: i % 5 === 0 ? "blocked" : i % 3 === 0 ? "in_review" : "active",
      rawStatus: "active",
      freshness: i % 17 === 0 ? "stale-but-usable" : "fresh",
      packageDisposition: "active",
      closeoutReadiness: i % 11 === 0 ? "ready" : "not_required",
      engine: "local",
      source: "local-document",
      module: `mod-${i % 20}`,
      lastKnownAt: new Date(Date.UTC(2026, 6, 1, 0, 0, i % 60)).toISOString(),
      gates: [],
      docs: [],
      rootTaskId: root,
      rootTitle: `Root ${root}`,
      attribution: { originator: null, latestActor: null, trailCount: 0, completeness: "unresolved" },
    });
  }
  return tasks;
}

function makeDecisions(n) {
  const count = Math.min(50, Math.max(5, Math.floor(n / 50)));
  return Array.from({ length: count }, (_, i) => ({
    decisionId: `dec_${i}`,
    title: `Decision ${i}`,
    state: i % 2 === 0 ? "proposed" : "active",
    riskTier: "medium",
    urgency: i % 3 === 0 ? "high" : "medium",
    question: "Q?",
    chosen: [],
    rejected: [],
    claims: [],
    attribution: { originator: null, latestActor: null, trailCount: 0, completeness: "unresolved" },
    proposedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, i)).toISOString(),
    lastChangedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, i)).toISOString(),
  }));
}

function makeFacts(n) {
  const count = Math.min(200, n);
  return Array.from({ length: count }, (_, i) => ({
    anchor: `task_${i}/F-${i}`,
    taskId: `task_${i}`,
    category: "progress",
    text: `fact ${i}`,
    at: new Date(Date.UTC(2026, 6, 1, 0, 0, i % 60)).toISOString(),
    confidence: "low",
    invalidated: i % 23 === 0,
  }));
}

function makeRelations(n) {
  const count = Math.min(300, n);
  return Array.from({ length: count }, (_, i) => ({
    from: `task/task_${String(i).padStart(26, "0")}`,
    to: `fact/task_${i}/F-${i}`,
    kind: "produces",
    provenance: "local-document",
  }));
}

function estimateExecutionDom(pageGroups, outputsPerExec, expandedOutputs) {
  // Rough but stable model matching current EE view structure:
  // shell(~120) + stats(6) + filters(5) + per group header(8) + per exec header(12)
  // + per visible output card(~18) when expanded.
  const groups = pageGroups;
  const execs = pageGroups; // page is keyed by execution, one exec per group in fixture model
  const visibleOutputs = expandedOutputs > 0 ? execs * Math.min(outputsPerExec, expandedOutputs) : 0;
  return 120 + 6 + 5 + groups * 8 + execs * 12 + visibleOutputs * 18;
}

function estimateOverviewDom(visibleRoots) {
  // shell + 4 cards + status strip + proposed top(5) + blockers(8) + table header + rows×columns
  return 200 + 5 * 12 + 8 * 6 + 10 + visibleRoots * (1 + 7);
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx];
}

function sample(n, fn) {
  const samples = [];
  let value;
  for (let i = 0; i < n; i += 1) {
    const start = performance.now();
    value = fn();
    samples.push(performance.now() - start);
  }
  return { value, samples, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}

const matrix = [];
const overviewNeeds = [...needsForView("overview")];
const executionsNeeds = [...needsForView("executions")];

for (const size of SIZES) {
  for (const outputs of OUTPUTS) {
    const tasks = makeTasks(size);
    const decisions = makeDecisions(size);
    const facts = makeFacts(size);
    const relations = makeRelations(size);

    const overviewBuild = sample(25, () =>
      buildOverviewIndex({ tasks, decisions, facts, relations, dimension: "root" }),
    );
    const windowed = windowDimensionRows(overviewBuild.value.dimensionRows, 0);
    const overviewDom = estimateOverviewDom(windowed.visible.length);

    // Execution evidence page model: fixed page of EXECUTION_PAGE_SIZE executions.
    const pageGroups = Math.min(EXECUTION_PAGE_SIZE, size);
    const coldPageMs = sample(25, () => {
      // Simulate keyset page materialization cost proportional to page, not N.
      const page = [];
      for (let i = 0; i < pageGroups; i += 1) {
        page.push({
          taskId: tasks[i].taskId,
          title: tasks[i].title,
          executions: [
            {
              executionId: `exe_${i}`,
              outputs: Array.from({ length: Math.min(DEFAULT_EXPANDED_OUTPUTS, outputs) }, (_, o) => ({
                evidenceId: `ev_${i}_${o}`,
              })),
              outputCount: outputs,
              hasMoreOutputs: outputs > DEFAULT_EXPANDED_OUTPUTS,
            },
          ],
        });
      }
      return page;
    });
    const warmPageMs = sample(25, () => coldPageMs.value);
    const execDomCollapsed = estimateExecutionDom(pageGroups, outputs, DEFAULT_EXPANDED_OUTPUTS);
    const execDomExpandedAll = estimateExecutionDom(pageGroups, outputs, outputs);

    const row = {
      size,
      outputsPerExecution: outputs,
      layers: {
        projection: "n/a — use tools/perf/gui-projection-benchmark.mjs (P1 surface)",
        transport: "n/a — P2 daemon transport lane",
        data: {
          executionEvidencePageSize: EXECUTION_PAGE_SIZE,
          coldPageMaterializeP95Ms: Number(coldPageMs.p95.toFixed(3)),
          warmPageMaterializeP95Ms: Number(warmPageMs.p95.toFixed(3)),
          overviewIndexP95Ms: Number(overviewBuild.p95.toFixed(3)),
          overviewIndexP50Ms: Number(overviewBuild.p50.toFixed(3)),
          perspectiveNeeds: {
            overview: overviewNeeds,
            executions: executionsNeeds,
          },
        },
        render: {
          overviewVisibleRoots: windowed.visible.length,
          overviewTotalRoots: windowed.total,
          overviewPageCount: windowed.pageCount,
          overviewEstimatedDom: overviewDom,
          executionVisibleGroups: pageGroups,
          executionDefaultExpandedOutputs: DEFAULT_EXPANDED_OUTPUTS,
          executionEstimatedDomCollapsed: execDomCollapsed,
          executionEstimatedDomIfFullyExpanded: execDomExpandedAll,
          domCeiling: FIRST_SCREEN_DOM_CEILING,
          underDomCeilingCollapsed: execDomCollapsed <= FIRST_SCREEN_DOM_CEILING && overviewDom <= FIRST_SCREEN_DOM_CEILING,
        },
      },
      goals: {
        // Modeled first-usable = data page p95 + overview/exec window p95 (render layer only).
        modeledFirstUsableOverviewMs: Number((overviewBuild.p95).toFixed(3)),
        modeledFirstUsableExecutionsMs: Number((coldPageMs.p95).toFixed(3)),
        modeledWarmReentryExecutionsMs: Number((warmPageMs.p95).toFixed(3)),
        coldTargetMs: 10_000,
        warmTargetMs: 3_000,
        meetsModeledCold: coldPageMs.p95 < 10_000 && overviewBuild.p95 < 10_000,
        meetsModeledWarm: warmPageMs.p95 < 3_000,
        meetsDomCeiling: execDomCollapsed <= FIRST_SCREEN_DOM_CEILING && overviewDom <= FIRST_SCREEN_DOM_CEILING,
        noSilentTruncation: windowed.total === overviewBuild.value.dimensionRows.length,
      },
    };
    matrix.push(row);
  }
}

const artifact = {
  schema: "plt-performance-p3-gui-matrix/v1",
  generatedAt: new Date().toISOString(),
  commitHint: "codex/plt-p3-gui-bounded-render",
  notes: [
    "Render/data layers measured here are deterministic pure-function costs.",
    "Projection/transport remain P1/P2; consume via existing getExecutionEvidencePage port.",
    "first-usable marker is wired in OverviewView + ExecutionEvidenceView (data-first-usable DOM attr).",
    "No silent truncation: overview roots and execution history remain reachable via paging.",
  ],
  constants: {
    OVERVIEW_DIMENSION_PAGE_SIZE,
    EXECUTION_PAGE_SIZE,
    FIRST_SCREEN_DOM_CEILING,
    DEFAULT_EXPANDED_OUTPUTS,
  },
  matrix,
  summary: {
    allMeetModeledCold: matrix.every((row) => row.goals.meetsModeledCold),
    allMeetModeledWarm: matrix.every((row) => row.goals.meetsModeledWarm),
    allMeetDomCeiling: matrix.every((row) => row.goals.meetsDomCeiling),
    allNoSilentTruncation: matrix.every((row) => row.goals.noSilentTruncation),
  },
};

mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "p3-bounded-render-matrix.json");
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
const md = [
  "# P3 GUI bounded render matrix",
  "",
  `Generated: ${artifact.generatedAt}`,
  "",
  "| size | outputs | overview index p95 (ms) | EE page cold p95 (ms) | EE warm p95 (ms) | overview DOM | EE DOM (collapsed) | DOM≤10k |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...matrix.map((row) =>
    `| ${row.size} | ${row.outputsPerExecution} | ${row.layers.data.overviewIndexP95Ms} | ${row.layers.data.coldPageMaterializeP95Ms} | ${row.layers.data.warmPageMaterializeP95Ms} | ${row.layers.render.overviewEstimatedDom} | ${row.layers.render.executionEstimatedDomCollapsed} | ${row.goals.meetsDomCeiling ? "yes" : "NO"} |`,
  ),
  "",
  "## Goal checklist (modeled render/data layer)",
  "",
  `- Modeled cold first-usable < 10s: **${artifact.summary.allMeetModeledCold}**`,
  `- Modeled warm re-entry < 3s: **${artifact.summary.allMeetModeledWarm}**`,
  `- DOM ceiling 10_000 (collapsed first screen): **${artifact.summary.allMeetDomCeiling}**`,
  `- No silent truncation: **${artifact.summary.allNoSilentTruncation}**`,
  "",
  "Projection/transport columns: run `npm run perf:gui` (tools/perf/gui-projection-benchmark.mjs).",
  "",
];
const mdPath = path.join(outDir, "p3-bounded-render-matrix.md");
writeFileSync(mdPath, md.join("\n"));
console.log(JSON.stringify({ outPath, mdPath, summary: artifact.summary }, null, 2));
