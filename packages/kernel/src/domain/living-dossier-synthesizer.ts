import { dossierContentMaxBytes } from "./cli-operational-policy.ts";
import { preserveExternalHtmlBody, preserveExternalMarkdownBody } from "./living-dossier-chronicler-merge.ts";
import { renderDossierHtmlDocument } from "./living-dossier-html.ts";
import {
  compactDossierState,
  emptyState,
  escapeMarkdownCell,
  mergeLedgerState,
  parseManagedState,
  resolveRootWorkId,
  serializeStateComment,
  type DossierChangeItem,
  type DossierDecisionRecord,
  type DossierLedgerEntry,
  type DossierLedgerState,
  type DossierSynthesisInput,
  type DossierTaskRecord,
  type DossierWorkRollup,
} from "./living-dossier-state.ts";

export { type DossierChangeItem, type DossierSynthesisInput };

const utf8Encoder = new TextEncoder();

const BUDGET_COMPACTION_PROFILES = [
  {
    maxPinnedWorks: 144,
    maxTrackedTasks: 96,
    maxOrphanCounters: 160,
    maxDecisions: 144,
    maxEntries: 36,
    maxRelations: 48,
    maxVisibleWorks: 128,
  },
  {
    maxPinnedWorks: 96,
    maxTrackedTasks: 64,
    maxOrphanCounters: 96,
    maxDecisions: 96,
    maxEntries: 24,
    maxRelations: 32,
    maxVisibleWorks: 96,
  },
  {
    maxPinnedWorks: 48,
    maxTrackedTasks: 48,
    maxOrphanCounters: 48,
    maxDecisions: 48,
    maxEntries: 16,
    maxRelations: 16,
    maxVisibleWorks: 48,
  },
  {
    maxPinnedWorks: 16,
    maxTrackedTasks: 16,
    maxOrphanCounters: 0,
    maxDecisions: 16,
    maxEntries: 8,
    maxRelations: 8,
    maxVisibleWorks: 16,
  },
] as const;

function activeBlockedTasks(state: DossierLedgerState): readonly DossierTaskRecord[] {
  return Object.values(state.tasks)
    .filter((task) => task.status === "blocked")
    .sort((left, right) => right.workspaceRevision - left.workspaceRevision);
}

function computeWorkRollups(state: DossierLedgerState, maxVisibleWorks = 256): readonly DossierWorkRollup[] {
  const taskMap = state.tasks;
  const workIds = new Set<string>(Object.keys(state.workCounters));
  for (const task of Object.values(taskMap)) {
    if (task.taskClass === "work") workIds.add(task.taskId);
    const rootId = resolveRootWorkId(task, taskMap);
    if (rootId) workIds.add(rootId);
  }

  const childrenByWork = new Map<string, DossierTaskRecord[]>();
  for (const id of workIds) childrenByWork.set(id, []);

  for (const task of Object.values(taskMap)) {
    const rootId = resolveRootWorkId(task, taskMap);
    if (rootId) childrenByWork.get(rootId)?.push(task);
  }

  const rollups: DossierWorkRollup[] = [];
  for (const workId of workIds) {
    const workRecord = taskMap[workId];
    const counter = state.workCounters[workId];
    const children = (childrenByWork.get(workId) ?? []).sort(
      (left, right) => right.workspaceRevision - left.workspaceRevision,
    );
    const liveDone = children.filter((child) => child.status === "done").length;
    const liveBlocked = children.filter((child) => child.status === "blocked").length;
    const liveCancelled = children.filter((child) => child.status === "cancelled").length;
    const totalTasks = children.length + (counter?.archivedTotal ?? 0);
    const doneTasks = liveDone + (counter?.archivedDone ?? 0);
    const blockedTasks = liveBlocked + (counter?.archivedBlocked ?? 0);
    const cancelledTasks = liveCancelled + (counter?.archivedCancelled ?? 0);
    const activeTasks = Math.max(0, totalTasks - doneTasks - blockedTasks - cancelledTasks);
    const latestRevision = Math.max(
      workRecord?.workspaceRevision ?? 0,
      counter?.latestRevision ?? 0,
      ...children.map((child) => child.workspaceRevision),
    );
    const packagePath = workRecord?.packagePath ?? counter?.packagePath;
    const countsIncomplete = Boolean(workRecord?.countsIncomplete || counter?.countsIncomplete);
    rollups.push({
      workId,
      title: workRecord?.title ?? counter?.title ?? workId,
      status:
        workRecord?.status ??
        (blockedTasks > 0 ? "blocked" : totalTasks > 0 && doneTasks === totalTasks ? "done" : "active"),
      totalTasks,
      doneTasks,
      blockedTasks,
      activeTasks,
      cancelledTasks,
      explainerPath: packagePath
        ? `${packagePath}/artifacts/explainer.html`
        : `task/${workId} · artifacts/explainer.html`,
      ...(packagePath ? { packagePath } : {}),
      latestRevision,
      recentChildIds: children.slice(0, 6).map((child) => child.taskId),
      ...(countsIncomplete ? { countsIncomplete: true } : {}),
    });
  }

  return rollups
    .sort((left, right) => right.latestRevision - left.latestRevision || left.workId.localeCompare(right.workId))
    .slice(0, maxVisibleWorks);
}

const MARKDOWN_ANCHOR_HEADINGS: Readonly<Record<string, string>> = {
  overview: "Overview",
  "active-invariants": "Active Invariants",
  "recent-changes": "Recent Changes",
  "active-decisions": "Active Decisions",
  "supersession-log": "Supersession Log",
  "delivery-arc": "Delivery Arc",
  "work-log": "Work Log",
  "capability-map": "Capability Map",
  "verification-log": "Verification Log",
  charter: "Charter",
  "aligned-scope": "Aligned Scope",
  "recent-updates": "Recent Updates",
  "deliverable-index": "Deliverable Index",
  "approval-trail": "Approval Trail",
  "ownership-transfers": "Ownership Transfers",
  "institutional-memory": "Institutional Memory",
};

function renderMarkdownEntryTable(
  rows: readonly DossierLedgerEntry[],
  anchor: string,
  targetWatermark: number,
): string[] {
  if (rows.length === 0) {
    return [`Observed 0 matching canonical changes for \`${anchor}\` through revision \`r${targetWatermark}\`.`, ""];
  }
  const lines = ["| Rev | Event | Entities | Summary | Actor |", "| --- | --- | --- | --- | --- |"];
  for (const row of rows) {
    const refs = row.entityRefs.join(", ") || row.eventId;
    lines.push(
      `| r${row.workspaceRevision} | \`${row.type}\` | \`${escapeMarkdownCell(refs)}\` | ${escapeMarkdownCell(row.summary)} | \`${escapeMarkdownCell(row.actorLabel)}\` |`,
    );
  }
  lines.push("");
  return lines;
}

function renderMarkdownDecisionsTable(decisions: readonly DossierDecisionRecord[], emptyMessage: string): string[] {
  if (decisions.length === 0) return [emptyMessage, ""];
  const lines = ["| Rev | Decision | State | Title / Rationale | Scope / Derived |", "| --- | --- | --- | --- | --- |"];
  for (const dec of decisions) {
    const scopeParts = [
      ...(dec.modules.length > 0 ? [`modules: ${dec.modules.join(", ")}`] : []),
      ...(dec.derivedTaskIds.length > 0 ? [`derives: ${dec.derivedTaskIds.join(", ")}`] : []),
    ];
    const detailParts = [
      dec.title,
      ...(dec.chosen && dec.chosen.length > 0 ? [`chosen: ${dec.chosen.join("; ")}`] : []),
      ...(dec.reason && dec.reason !== dec.title ? [dec.reason] : []),
    ];
    lines.push(
      `| r${dec.workspaceRevision} | \`decision/${escapeMarkdownCell(dec.decisionId)}\` | \`${dec.state}\` | ${escapeMarkdownCell(detailParts.join(" — "))} | ${escapeMarkdownCell(scopeParts.join(" · ") || "—")} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderMarkdownAnchorBody(
  anchor: string,
  state: DossierLedgerState,
  targetWatermark: number,
  maxVisibleWorks: number,
): string[] {
  const activeDecisions = Object.values(state.activeDecisions).sort(
    (left, right) => right.workspaceRevision - left.workspaceRevision,
  );
  const workRollups = computeWorkRollups(state, maxVisibleWorks);

  switch (anchor) {
    case "overview": {
      const surfaces = [...new Set(Object.values(state.tasks).flatMap((task) => task.surfaces))].slice(0, 12);
      const modules = [...new Set(activeDecisions.flatMap((decision) => decision.modules))].slice(0, 12);
      const blocked = activeBlockedTasks(state);
      const lines = [
        `- Active Decisions: ${activeDecisions.length} · Tracked Works: ${workRollups.length} · Live Blocked Tasks: ${blocked.length} · Active Relations: ${state.relations.length}`,
      ];
      if (surfaces.length > 0 || modules.length > 0) {
        lines.push(
          `- Observed Surfaces / Modules: ${[...new Set([...modules, ...surfaces])].map((item) => `\`${item}\``).join(", ")}`,
        );
      }
      lines.push("");
      return [...lines, ...renderMarkdownEntryTable(state.entries.slice(0, 12), anchor, targetWatermark)];
    }
    case "active-decisions":
      return renderMarkdownDecisionsTable(
        activeDecisions,
        `Observed 0 active decisions through revision \`r${targetWatermark}\`.`,
      );
    case "active-invariants": {
      const factRows = state.entries.filter((entry) => entry.category === "fact").slice(0, 10);
      if (activeDecisions.length === 0 && factRows.length === 0) {
        return [`Observed 0 active decisions or verified facts through revision \`r${targetWatermark}\`.`, ""];
      }
      const lines: string[] = [];
      if (activeDecisions.length > 0) {
        lines.push(...renderMarkdownDecisionsTable(activeDecisions, ""));
      }
      if (factRows.length > 0) {
        lines.push(...renderMarkdownEntryTable(factRows, anchor, targetWatermark));
      }
      return lines;
    }
    case "supersession-log":
      return renderMarkdownDecisionsTable(
        state.retiredDecisions,
        `Observed 0 superseded or retired decisions through revision \`r${targetWatermark}\`.`,
      );
    case "delivery-arc": {
      if (workRollups.length === 0) {
        return [`Observed 0 Work streams with child rollup through revision \`r${targetWatermark}\`.`, ""];
      }
      const lines = [
        "| Work | Title | Status | Progress | Blocked | Explainer | Latest Rev |",
        "| --- | --- | --- | --- | --- | --- | --- |",
      ];
      for (const work of workRollups) {
        const progressLabel = `${work.doneTasks}/${work.totalTasks}${work.countsIncomplete ? " (partial)" : ""}`;
        lines.push(
          `| \`${escapeMarkdownCell(work.workId)}\` | ${escapeMarkdownCell(work.title)} | \`${work.status}\` | ${progressLabel} | ${work.blockedTasks} | \`${escapeMarkdownCell(work.explainerPath)}\` | r${work.latestRevision} |`,
        );
      }
      lines.push("");
      return lines;
    }
    case "work-log":
      return renderMarkdownEntryTable(
        state.entries.filter((entry) => entry.category === "task").slice(0, 20),
        anchor,
        targetWatermark,
      );
    case "capability-map": {
      const delivered = Object.values(state.tasks)
        .filter((task) => task.status === "done")
        .sort((left, right) => right.workspaceRevision - left.workspaceRevision)
        .slice(0, 20);
      if (delivered.length === 0) {
        return renderMarkdownEntryTable(
          state.entries.filter((entry) => entry.category === "task" && entry.type === "task_completed").slice(0, 20),
          anchor,
          targetWatermark,
        );
      }
      const lines = ["| Rev | Task | Capability | Surfaces |", "| --- | --- | --- | --- |"];
      for (const task of delivered) {
        lines.push(
          `| r${task.workspaceRevision} | \`task/${escapeMarkdownCell(task.taskId)}\` | ${escapeMarkdownCell(task.title)} | ${escapeMarkdownCell(task.surfaces.join(", ") || "—")} |`,
        );
      }
      lines.push("");
      return lines;
    }
    case "verification-log":
      return renderMarkdownEntryTable(
        state.entries.filter((entry) => entry.category === "fact").slice(0, 20),
        anchor,
        targetWatermark,
      );
    case "charter":
      return renderMarkdownEntryTable(
        state.entries.filter((entry) => entry.kinds.includes("project-brief")).slice(0, 20),
        anchor,
        targetWatermark,
      );
    case "aligned-scope": {
      const scopeRows = state.entries.filter((entry) => entry.kinds.includes("minutes") || entry.category === "fact");
      if (activeDecisions.length === 0 && scopeRows.length === 0) {
        return [`Observed 0 active decisions or scope updates through revision \`r${targetWatermark}\`.`, ""];
      }
      const lines: string[] = [];
      if (activeDecisions.length > 0) lines.push(...renderMarkdownDecisionsTable(activeDecisions, ""));
      if (scopeRows.length > 0)
        lines.push(...renderMarkdownEntryTable(scopeRows.slice(0, 12), anchor, targetWatermark));
      return lines;
    }
    case "deliverable-index":
      return renderMarkdownEntryTable(
        state.entries.filter((entry) => entry.kinds.includes("deliverable")).slice(0, 20),
        anchor,
        targetWatermark,
      );
    case "approval-trail":
      return renderMarkdownEntryTable(
        state.entries.filter((entry) => entry.category === "task" || entry.category === "fact").slice(0, 20),
        anchor,
        targetWatermark,
      );
    case "ownership-transfers":
      return renderMarkdownEntryTable(
        state.entries.filter((entry) => entry.kinds.includes("handoff")).slice(0, 20),
        anchor,
        targetWatermark,
      );
    case "institutional-memory":
      return renderMarkdownEntryTable(
        state.entries
          .filter((entry) => entry.kinds.includes("memory-item") || entry.kinds.includes("minutes"))
          .slice(0, 20),
        anchor,
        targetWatermark,
      );
    default:
      return renderMarkdownEntryTable(state.entries.slice(0, 20), anchor, targetWatermark);
  }
}

function renderMarkdownDocument(
  input: DossierSynthesisInput,
  state: DossierLedgerState,
  stateComment: string,
  maxVisibleWorks: number,
): string {
  const { verticalId, slot, expectedWatermark, targetWatermark } = input;
  const headingLines = [
    `<!-- dossier-watermark: ${targetWatermark} -->`,
    `# ${slot.title}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Vertical | \`${verticalId}\` |`,
    `| Slot | \`${slot.id}\` (\`${slot.path}\`) |`,
    `| Watermark | \`r${targetWatermark}\` (window \`r${expectedWatermark}\` -> \`r${targetWatermark}\`) |`,
    `| Synthesized At | \`${state.synthesizedAt}\` |`,
    `| Entity Kinds | ${slot.entityKinds.map((kind) => `\`${kind}\``).join(", ")} |`,
    `| Tracked Changes | ${state.totalChanges} total (+${input.changes.length} in window) |`,
    "",
  ];

  const anchors = slot.requiredAnchors.length > 0 ? slot.requiredAnchors : ["overview"];
  const sectionLines: string[] = [];
  for (const anchor of anchors) {
    const title = MARKDOWN_ANCHOR_HEADINGS[anchor] ?? anchor.replaceAll("-", " ");
    sectionLines.push(`<!-- dossier-anchor: ${anchor} -->`, `## ${title}`, "");
    sectionLines.push(...renderMarkdownAnchorBody(anchor, state, targetWatermark, maxVisibleWorks));
  }

  return [...headingLines, ...sectionLines, stateComment, ""].join("\n");
}

function renderManagedCandidate(
  input: DossierSynthesisInput,
  state: DossierLedgerState,
  maxVisibleWorks: number,
): string {
  const stateComment = serializeStateComment(state, input.slot.kind === "html");
  if (input.slot.kind === "html") {
    return renderDossierHtmlDocument({
      verticalId: input.verticalId,
      slot: input.slot,
      state,
      workRollups: computeWorkRollups(state, maxVisibleWorks),
      blockedTasks: activeBlockedTasks(state),
      expectedWatermark: input.expectedWatermark,
      windowChangeCount: input.changes.length,
      stateComment,
    });
  }
  return renderMarkdownDocument(input, state, stateComment, maxVisibleWorks);
}

/**
 * Pure deterministic incremental dossier synthesizer.
 * Consumes the prior slot body and one bounded revision window, returning a validated-ready
 * Markdown or offline standalone HTML document pinned to `targetWatermark`.
 * Preserves externally authored (chronicler) documents without overwriting their narrative.
 */
export function synthesizeDossierDocument(input: DossierSynthesisInput): string {
  const managedPrior = parseManagedState(input.previousBody, input.synthesizedAt);
  if (managedPrior === null && input.previousBody !== null && input.previousBody.trim().length > 0) {
    return input.slot.kind === "html"
      ? preserveExternalHtmlBody(input, input.previousBody)
      : preserveExternalMarkdownBody(input, input.previousBody);
  }

  const prior = managedPrior ?? emptyState(input.expectedWatermark, input.synthesizedAt);
  let state = mergeLedgerState(input, prior);
  let candidate = renderManagedCandidate(input, state, 256);
  if (utf8Encoder.encode(candidate).byteLength <= dossierContentMaxBytes) {
    return candidate;
  }

  for (const profile of BUDGET_COMPACTION_PROFILES) {
    state = compactDossierState(state, profile);
    candidate = renderManagedCandidate(input, state, profile.maxVisibleWorks);
    if (utf8Encoder.encode(candidate).byteLength <= dossierContentMaxBytes) {
      return candidate;
    }
  }
  return candidate;
}
