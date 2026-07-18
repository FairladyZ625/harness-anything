/**
 * P3 wall-clock markdown report + pre-fix baseline table.
 */
export const COLD_TARGET_MS = 10_000;
export const WARM_TARGET_MS = 3_000;
export const DOM_CEILING = 10_000;

/** Pre-fix baselines from original PLT-P3 task_plan Context (unbounded first screen). */
export const PRE_FIX = {
  "1000x1": { firstNavS: 1.37, reentryS: 0.81, dom: 34_154, longTaskMs: 306 },
  "1000x5": { firstNavS: 2.37, reentryS: 1.66, dom: 82_154, longTaskMs: 715 },
  "5000x1": {
    launchToUsableS: 13.92,
    firstEvidenceNavS: 6.88,
    reentryS: 4.11,
    dom: 170_154,
    longTaskMs: 1_590,
  },
};


export function verdict(met) {
  if (met === null || met === undefined) return "n/a";
  return met ? "MET" : "NOT MET";
}

export function buildMarkdown(artifact) {
  const lines = [];
  lines.push("# P3 GUI wall-clock matrix (REAL Electron measurements)");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push(`Head SHA: ${artifact.headSha}`);
  lines.push(`Host: ${artifact.host}`);
  lines.push("");
  lines.push("## Targets (from task_plan Verification)");
  lines.push("");
  lines.push("- 1,000 Execution: cold first-usable < 10 s, warm re-entry < 3 s, DOM ≤ 10,000");
  lines.push("- 5,000 Execution: operable first screen within 10 s, no crash, DOM ≤ 10,000");
  lines.push("- first-usable = real interactive content (data-first-usable marker), never empty shell");
  lines.push("");
  lines.push("## Measured matrix");
  lines.push("");
  lines.push(
    "| size | outs | launch→Overview usable (ms) | EE first-nav (ms) | EE warm re-entry (ms) | Overview DOM | EE DOM | EE longest longtask (ms) | RSS (KB) | EE cold <10s | EE warm <3s | DOM≤10k |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of artifact.matrix) {
    if (row.error) {
      lines.push(
        `| ${row.size} | ${row.outputsPerExecution} | ERROR | ERROR | ERROR | — | — | — | — | FAIL | FAIL | FAIL |`,
      );
      continue;
    }
    const c = row.cold;
    const w = row.warm;
    lines.push(
      `| ${row.size} | ${row.outputsPerExecution} | ${c.launchToOverviewFirstUsableMs} | ${c.executionsFirstNavMs} | ${w.executionsReentryMs} | ${c.overview.domCount} | ${c.executions.domCount} | ${c.executions.longestLongTaskMs} | ${c.executions.rssKb ?? "—"} | ${verdict(row.goals.executionsColdFirstNavMet)} | ${verdict(row.goals.executionsWarmReentryMet)} | ${verdict(row.goals.overviewDomMet && row.goals.executionsDomMet)} |`,
    );
  }
  lines.push("");
  lines.push("## Layer attribution");
  lines.push("");
  lines.push(
    "Wall-clock first-usable = projection rebuild/ready (cold only) + transport (daemon RPC) + data materialize + render. Projection/transport measured by `npm run perf:gui`; data/render from Electron markers.",
  );
  lines.push("");
  for (const row of artifact.matrix) {
    lines.push(`### ${row.label}`);
    lines.push("");
    if (row.error) {
      lines.push(`**BLOCKER:** ${row.error.message}`);
      lines.push("");
      continue;
    }
    const proj = row.layers?.projectionTransport;
    const c = row.cold;
    lines.push("| layer | metric | ms | source |");
    lines.push("| --- | --- | --- | --- |");
    if (proj?.ok) {
      lines.push(
        `| projection | evidence facet rebuild | ${proj.milliseconds?.evidenceFacetBuild ?? "—"} | perf:gui |`,
      );
      lines.push(
        `| projection | task projection rebuild | ${proj.milliseconds?.rebuild ?? "—"} | perf:gui |`,
      );
      lines.push(
        `| transport | daemon generation ready (first page) | ${proj.milliseconds?.daemonGenerationReady ?? "—"} | perf:gui |`,
      );
      lines.push(
        `| transport | daemon evidence page p95 | ${proj.milliseconds?.queryExecutionEvidencePageFromDaemonGeneration?.p95 ?? "—"} | perf:gui |`,
      );
      lines.push(
        `| data | ready-generation page p95 | ${proj.milliseconds?.queryExecutionEvidencePageFromReadyGeneration?.p95 ?? "—"} | perf:gui |`,
      );
      lines.push(
        `| data | triadic snapshot p95 | ${proj.milliseconds?.readTriadicProjectionSnapshot?.p95 ?? "—"} | perf:gui |`,
      );
    } else {
      lines.push(
        `| projection/transport | (see error) | — | ${proj?.error ?? "skipped/failed"} |`,
      );
    }
    lines.push(
      `| render | Overview in-view first-usable | ${c.overview.inView.navigationStartToFirstUsableMs ?? "—"} | __harnessPerfTrace |`,
    );
    lines.push(
      `| render | EE in-view first-usable | ${c.executions.inView.navigationStartToFirstUsableMs ?? "—"} | __harnessPerfTrace |`,
    );
    lines.push(
      `| wall | launch → Overview first-usable | ${c.launchToOverviewFirstUsableMs} | Electron wall clock |`,
    );
    lines.push(
      `| wall | EE first navigation | ${c.executionsFirstNavMs} | Electron wall clock |`,
    );
    lines.push(
      `| wall | EE warm re-entry | ${row.warm.executionsReentryMs} | Electron wall clock |`,
    );
    lines.push("");
    lines.push(
      `In-view EE first-usable (${c.executions.inView.navigationStartToFirstUsableMs ?? "n/a"} ms) is the render+data portion after navigation; cold launch wall includes daemon autostart + projection if not warm.`,
    );
    lines.push("");
  }

  lines.push("## Pre-fix baselines (task_plan Context) vs measured");
  lines.push("");
  lines.push("| case | baseline | measured | Δ |");
  lines.push("| --- | --- | --- | --- |");
  for (const key of Object.keys(PRE_FIX)) {
    const base = PRE_FIX[key];
    // labels are like 1000x1
    const measured = artifact.matrix.find((r) => r.label === key);
    if (!measured || measured.error) {
      lines.push(`| ${key} | ${JSON.stringify(base)} | ERROR/missing | — |`);
      continue;
    }
    if (key === "5000x1") {
      lines.push(
        `| ${key} launch-to-usable | ${base.launchToUsableS}s | ${(measured.cold.launchToOverviewFirstUsableMs / 1000).toFixed(2)}s (Overview) / ${(measured.cold.launchToExecutionsFirstUsableMs / 1000).toFixed(2)}s (EE) | — |`,
      );
      lines.push(
        `| ${key} EE first nav | ${base.firstEvidenceNavS}s | ${(measured.cold.executionsFirstNavMs / 1000).toFixed(2)}s | ${((measured.cold.executionsFirstNavMs / 1000) - base.firstEvidenceNavS).toFixed(2)}s |`,
      );
      lines.push(
        `| ${key} EE re-entry | ${base.reentryS}s | ${(measured.warm.executionsReentryMs / 1000).toFixed(2)}s | ${((measured.warm.executionsReentryMs / 1000) - base.reentryS).toFixed(2)}s |`,
      );
      lines.push(
        `| ${key} DOM | ${base.dom} | Overview ${measured.cold.overview.domCount} / EE ${measured.cold.executions.domCount} | — |`,
      );
    } else {
      lines.push(
        `| ${key} first nav | ${base.firstNavS}s | ${(measured.cold.executionsFirstNavMs / 1000).toFixed(2)}s | ${((measured.cold.executionsFirstNavMs / 1000) - base.firstNavS).toFixed(2)}s |`,
      );
      lines.push(
        `| ${key} re-entry | ${base.reentryS}s | ${(measured.warm.executionsReentryMs / 1000).toFixed(2)}s | ${((measured.warm.executionsReentryMs / 1000) - base.reentryS).toFixed(2)}s |`,
      );
      lines.push(
        `| ${key} DOM | ${base.dom} | Overview ${measured.cold.overview.domCount} / EE ${measured.cold.executions.domCount} | — |`,
      );
    }
  }
  lines.push("");
  lines.push("## Goal checklist (REAL, not modeled)");
  lines.push("");
  for (const row of artifact.matrix) {
    if (row.error) {
      lines.push(`- ${row.label}: **BLOCKED** — ${row.error.message}`);
      continue;
    }
    lines.push(
      `- ${row.label}: EE cold first-nav ${row.cold.executionsFirstNavMs}ms → **${verdict(row.goals.executionsColdFirstNavMet)}** (<${COLD_TARGET_MS}ms); warm ${row.warm.executionsReentryMs}ms → **${verdict(row.goals.executionsWarmReentryMet)}** (<${WARM_TARGET_MS}ms); DOM Overview ${row.cold.overview.domCount} / EE ${row.cold.executions.domCount} → **${verdict(row.goals.overviewDomMet && row.goals.executionsDomMet)}** (≤${DOM_CEILING})`,
    );
  }
  lines.push("");
  if (artifact.blockers?.length) {
    lines.push("## Blockers");
    lines.push("");
    for (const b of artifact.blockers) lines.push(`- ${b}`);
    lines.push("");
  }
  lines.push("## Method");
  lines.push("");
  lines.push("- Driver: Playwright `_electron` + `packages/gui/src/main/electron-main.ts` (ADR-0025).");
  lines.push("- first-usable: DOM `[data-first-usable=true][data-first-usable-view=…]` published by OverviewView / ExecutionEvidenceView after real data.");
  lines.push("- Cold launch includes Electron boot + daemon autostart + projection materialize.");
  lines.push("- Warm re-entry: navigate away to the other view, then back; measures same-session cache path.");
  lines.push("- Long tasks: PerformanceObserver entryType=longtask in renderer.");
  lines.push("- Heap: `performance.memory`; RSS: `ps` on Electron main PID + `app.getAppMetrics()` working set.");
  lines.push("");
  return lines.join("\n");
}


