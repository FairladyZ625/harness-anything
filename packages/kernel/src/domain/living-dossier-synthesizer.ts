import { preserveExternalHtmlBody, preserveExternalMarkdownBody } from "./living-dossier-chronicler-merge.ts";
import { renderDossierHtmlDocument } from "./living-dossier-html.ts";
import {
  DOSSIER_PAGE_SIZE,
  activeBlockedTasks,
  computeWorkRollups,
  emptyState,
  escapeMarkdownCell,
  mergeLedgerState,
  parseManagedState,
  serializeStateComment,
  type DossierChangeItem,
  type DossierDecisionRecord,
  type DossierLedgerEntry,
  type DossierLedgerState,
  type DossierSynthesisInput,
} from "./living-dossier-state.ts";

export { DOSSIER_PAGE_SIZE, type DossierChangeItem, type DossierSynthesisInput };

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

function renderMarkdownAnchorBody(anchor: string, state: DossierLedgerState, targetWatermark: number): string[] {
  const activeDecisions = Object.values(state.activeDecisions).sort(
    (left, right) => right.workspaceRevision - left.workspaceRevision,
  );
  const workRollups = computeWorkRollups(state);

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
        lines.push(
          `| \`${escapeMarkdownCell(work.workId)}\` | ${escapeMarkdownCell(work.title)} | \`${work.status}\` | ${work.doneTasks}/${work.totalTasks} | ${work.blockedTasks} | \`${escapeMarkdownCell(work.explainerPath)}\` | r${work.latestRevision} |`,
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

function renderMarkdownDocument(input: DossierSynthesisInput, state: DossierLedgerState, stateComment: string): string {
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
    sectionLines.push(...renderMarkdownAnchorBody(anchor, state, targetWatermark));
  }

  return [...headingLines, ...sectionLines, stateComment, ""].join("\n");
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
  const state = mergeLedgerState(input, prior);
  const stateComment = serializeStateComment(state, input.slot.kind === "html");
  if (input.slot.kind === "html") {
    return renderDossierHtmlDocument({
      verticalId: input.verticalId,
      slot: input.slot,
      state,
      workRollups: computeWorkRollups(state),
      blockedTasks: activeBlockedTasks(state),
      expectedWatermark: input.expectedWatermark,
      windowChangeCount: input.changes.length,
      stateComment,
    });
  }
  return renderMarkdownDocument(input, state, stateComment);
}
