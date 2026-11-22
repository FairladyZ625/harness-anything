import type { DossierSlot } from "./living-dossier.ts";
import { renderDossierHtmlDocument } from "./living-dossier-html.ts";

export const DOSSIER_PAGE_SIZE = 64;

const STATE_COMMENT_PREFIX = "<!-- dossier-state:v1 ";
const STATE_COMMENT_SUFFIX = " -->";
const MAX_STORED_ENTRIES = 48;

export interface DossierChangeItem {
  readonly eventId: string;
  readonly schema: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly taskId?: string;
  readonly actor?: {
    readonly executor?: { readonly id: string };
    readonly principal?: { readonly personId: string };
  };
  readonly payload: Readonly<Record<string, unknown>>;
  readonly entityRefs: readonly string[];
}

export interface DossierSynthesisInput {
  readonly verticalId: string;
  readonly slot: DossierSlot;
  readonly previousBody: string | null;
  readonly expectedWatermark: number;
  readonly targetWatermark: number;
  readonly changes: readonly DossierChangeItem[];
  readonly synthesizedAt: string;
}

export interface DossierLedgerEntry {
  readonly eventId: string;
  readonly schema: string;
  readonly type: string;
  readonly category: "task" | "decision" | "fact" | "domain";
  readonly workspaceRevision: number;
  readonly occurredAt: string;
  readonly entityRefs: readonly string[];
  readonly kinds: readonly string[];
  readonly actorLabel: string;
  readonly summary: string;
  readonly riskSignal: boolean;
}

export interface DossierLedgerState {
  readonly watermark: number;
  readonly synthesizedAt: string;
  readonly totalChanges: number;
  readonly categoryCounts: {
    readonly task: number;
    readonly decision: number;
    readonly fact: number;
    readonly domain: number;
  };
  readonly kindCounts: Readonly<Record<string, number>>;
  readonly entries: readonly DossierLedgerEntry[];
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

function sanitizeSingleLine(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function classifyCategory(change: DossierChangeItem): "task" | "decision" | "fact" | "domain" {
  if (change.schema === "task-event/v1") return "task";
  if (change.schema === "decision-event/v1") return "decision";
  if (change.schema === "fact-event/v1") return "fact";
  return "domain";
}

function extractKinds(change: DossierChangeItem, slot: DossierSlot): readonly string[] {
  const found = new Set<string>();
  const declared = new Set(slot.entityKinds);
  for (const ref of change.entityRefs) {
    const slash = ref.lastIndexOf("/");
    const head = slash > 0 ? ref.slice(0, slash) : ref;
    if (declared.has(head)) found.add(head);
    else if (head.startsWith("entity-kind/")) {
      const payloadKind = typeof change.payload.entityKind === "string" ? change.payload.entityKind : null;
      if (payloadKind && declared.has(payloadKind)) found.add(payloadKind);
    }
  }
  const category = classifyCategory(change);
  if (found.size === 0 && declared.has(category)) found.add(category);
  if (found.size === 0 && slot.entityKinds.length > 0) found.add(slot.entityKinds[0]!);
  return [...found];
}

function isRiskEvent(change: DossierChangeItem): boolean {
  return (
    change.type.includes("superseded") ||
    change.type.includes("retired") ||
    change.type.includes("blocked") ||
    change.type.includes("cancelled")
  );
}

function summarizeChange(change: DossierChangeItem): string {
  const candidate =
    typeof change.payload.title === "string"
      ? change.payload.title
      : typeof change.payload.statement === "string"
        ? change.payload.statement
        : typeof change.payload.text === "string"
          ? change.payload.text
          : null;
  if (candidate && candidate.trim().length > 0) return sanitizeSingleLine(candidate);
  const target = change.entityRefs[0] ?? change.taskId ?? change.eventId;
  return sanitizeSingleLine(`${change.type} (${target})`);
}

function actorOf(change: DossierChangeItem): string {
  return change.actor?.principal?.personId ?? change.actor?.executor?.id ?? "system";
}

function toLedgerEntry(change: DossierChangeItem, slot: DossierSlot): DossierLedgerEntry {
  return {
    eventId: change.eventId,
    schema: change.schema,
    type: change.type,
    category: classifyCategory(change),
    workspaceRevision: change.workspaceRevision,
    occurredAt: change.occurredAt,
    entityRefs: [...change.entityRefs],
    kinds: extractKinds(change, slot),
    actorLabel: actorOf(change),
    summary: summarizeChange(change),
    riskSignal: isRiskEvent(change),
  };
}

function emptyState(watermark: number, synthesizedAt: string): DossierLedgerState {
  return {
    watermark,
    synthesizedAt,
    totalChanges: 0,
    categoryCounts: { task: 0, decision: 0, fact: 0, domain: 0 },
    kindCounts: {},
    entries: [],
  };
}

function parsePriorState(
  previousBody: string | null,
  fallbackWatermark: number,
  synthesizedAt: string,
): DossierLedgerState {
  if (!previousBody) return emptyState(fallbackWatermark, synthesizedAt);
  const start = previousBody.lastIndexOf(STATE_COMMENT_PREFIX);
  if (start === -1) return emptyState(fallbackWatermark, synthesizedAt);
  const end = previousBody.indexOf(STATE_COMMENT_SUFFIX, start + STATE_COMMENT_PREFIX.length);
  if (end === -1) return emptyState(fallbackWatermark, synthesizedAt);
  const raw = previousBody.slice(start + STATE_COMMENT_PREFIX.length, end).trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return emptyState(fallbackWatermark, synthesizedAt);
  const parsed = JSON.parse(raw) as Partial<DossierLedgerState>;
  if (
    typeof parsed.watermark !== "number" ||
    typeof parsed.totalChanges !== "number" ||
    !parsed.categoryCounts ||
    !Array.isArray(parsed.entries)
  )
    return emptyState(fallbackWatermark, synthesizedAt);
  return {
    watermark: parsed.watermark,
    synthesizedAt: typeof parsed.synthesizedAt === "string" ? parsed.synthesizedAt : synthesizedAt,
    totalChanges: parsed.totalChanges,
    categoryCounts: {
      task: Number(parsed.categoryCounts.task ?? 0),
      decision: Number(parsed.categoryCounts.decision ?? 0),
      fact: Number(parsed.categoryCounts.fact ?? 0),
      domain: Number(parsed.categoryCounts.domain ?? 0),
    },
    kindCounts: typeof parsed.kindCounts === "object" && parsed.kindCounts !== null ? parsed.kindCounts : {},
    entries: parsed.entries.slice(0, MAX_STORED_ENTRIES),
  };
}

function serializeStateComment(state: DossierLedgerState): string {
  const safeJson = JSON.stringify(state)
    .replaceAll("--", "\\u002d\\u002d")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  return `${STATE_COMMENT_PREFIX}${safeJson}${STATE_COMMENT_SUFFIX}`;
}

function mergeLedgerState(input: DossierSynthesisInput): DossierLedgerState {
  const prior = parsePriorState(input.previousBody, input.expectedWatermark, input.synthesizedAt);
  const seen = new Set(prior.entries.map((entry) => entry.eventId));
  const categoryCounts = { ...prior.categoryCounts };
  const kindCounts: Record<string, number> = { ...prior.kindCounts };
  const incoming: DossierLedgerEntry[] = [];
  for (const change of input.changes) {
    if (seen.has(change.eventId)) continue;
    seen.add(change.eventId);
    const entry = toLedgerEntry(change, input.slot);
    incoming.push(entry);
    categoryCounts[entry.category] += 1;
    for (const kind of entry.kinds) kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
  }
  const merged = [...incoming, ...prior.entries]
    .sort(
      (left, right) => right.workspaceRevision - left.workspaceRevision || right.eventId.localeCompare(left.eventId),
    )
    .slice(0, MAX_STORED_ENTRIES);
  return {
    watermark: input.targetWatermark,
    synthesizedAt: input.synthesizedAt,
    totalChanges: prior.totalChanges + incoming.length,
    categoryCounts,
    kindCounts,
    entries: merged,
  };
}

function selectAnchorEntries(anchor: string, state: DossierLedgerState): readonly DossierLedgerEntry[] {
  switch (anchor) {
    case "active-decisions":
    case "active-invariants":
    case "charter":
      return state.entries.filter((entry) => entry.category === "decision" && !entry.riskSignal);
    case "supersession-log":
      return state.entries.filter((entry) => entry.riskSignal);
    case "delivery-arc":
    case "work-log":
    case "capability-map":
      return state.entries.filter((entry) => entry.category === "task");
    case "verification-log":
      return state.entries.filter((entry) => entry.category === "fact");
    case "deliverable-index":
    case "approval-trail":
      return state.entries.filter((entry) => entry.kinds.includes("deliverable") || entry.category === "task");
    case "ownership-transfers":
    case "institutional-memory":
      return state.entries.filter((entry) => entry.kinds.includes("handoff") || entry.kinds.includes("memory-item"));
    default:
      return state.entries;
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
    const rows = selectAnchorEntries(anchor, state).slice(0, 20);
    sectionLines.push(`<!-- dossier-anchor: ${anchor} -->`, `## ${title}`, "");
    if (rows.length === 0) {
      sectionLines.push(
        `Observed 0 matching canonical changes for \`${anchor}\` through revision \`r${targetWatermark}\`.`,
        "",
      );
      continue;
    }
    sectionLines.push("| Rev | Event | Entities | Summary | Actor |", "| --- | --- | --- | --- | --- |");
    for (const row of rows) {
      const refs = row.entityRefs.join(", ") || row.eventId;
      const summary = row.summary.replaceAll("|", "/");
      sectionLines.push(
        `| r${row.workspaceRevision} | \`${row.type}\` | \`${refs}\` | ${summary} | \`${row.actorLabel}\` |`,
      );
    }
    sectionLines.push("");
  }

  return [...headingLines, ...sectionLines, stateComment, ""].join("\n");
}

/**
 * Pure deterministic incremental dossier synthesizer.
 * Consumes the prior slot body and one bounded revision window, returning a validated-ready
 * Markdown or offline standalone HTML document pinned to `targetWatermark`.
 */
export function synthesizeDossierDocument(input: DossierSynthesisInput): string {
  const state = mergeLedgerState(input);
  const stateComment = serializeStateComment(state);
  if (input.slot.kind === "html") {
    return renderDossierHtmlDocument({
      verticalId: input.verticalId,
      slot: input.slot,
      state,
      expectedWatermark: input.expectedWatermark,
      windowChangeCount: input.changes.length,
      stateComment,
    });
  }
  return renderMarkdownDocument(input, state, stateComment);
}
