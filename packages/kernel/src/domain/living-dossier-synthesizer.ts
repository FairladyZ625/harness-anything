import type { DossierSlot } from "./living-dossier.ts";
import { renderDossierHtmlDocument, sanitizeExternalUrlText } from "./living-dossier-html.ts";

export const DOSSIER_PAGE_SIZE = 64;

const STATE_COMMENT_PREFIX = "<!-- dossier-state:v1 ";
const STATE_COMMENT_SUFFIX = " -->";
const INCREMENTAL_MD_START = "<!-- dossier-incremental-updates:start -->";
const INCREMENTAL_MD_END = "<!-- dossier-incremental-updates:end -->";
const MAX_STORED_ENTRIES = 48;
const MAX_ACTIVE_DECISIONS = 256;
const MAX_RETIRED_DECISIONS = 48;
const MAX_TRACKED_TASKS = 128;
const MAX_TRACKED_RELATIONS = 64;

interface DossierRelationPayload {
  readonly relationId?: string;
  readonly source?: string;
  readonly target?: string;
  readonly sourceKind?: string;
  readonly targetKind?: string;
  readonly relationType?: string;
  readonly state?: string;
  readonly rationale?: string;
}

export interface DossierChangeItem {
  readonly eventId: string;
  readonly schema: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly taskId?: string;
  readonly decisionId?: string;
  readonly factId?: string;
  readonly actor?: {
    readonly executor?: { readonly id: string };
    readonly principal?: { readonly personId: string };
  };
  readonly payload: Readonly<Record<string, unknown>>;
  readonly entityRefs: readonly string[];
  readonly matchedKinds?: readonly string[];
}

export interface DossierSynthesisInput {
  readonly verticalId: string;
  readonly slot: DossierSlot;
  readonly previousBody: string | null;
  readonly expectedWatermark: number;
  readonly targetWatermark: number;
  readonly changes: readonly DossierChangeItem[];
  readonly synthesizedAt: string;
  readonly kindMap?: Readonly<Record<string, string>>;
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

export interface DossierDecisionRecord {
  readonly decisionId: string;
  readonly title: string;
  readonly state: "in_effect" | "superseded" | "retired";
  readonly workspaceRevision: number;
  readonly occurredAt: string;
  readonly actorLabel: string;
  readonly reason?: string;
  readonly modules: readonly string[];
  readonly derivedTaskIds: readonly string[];
}

export interface DossierTaskRecord {
  readonly taskId: string;
  readonly title: string;
  readonly taskClass: "work" | "standard" | "long_running";
  readonly status: string;
  readonly parentTaskId: string | null;
  readonly surfaces: readonly string[];
  readonly workspaceRevision: number;
  readonly occurredAt: string;
  readonly actorLabel: string;
  readonly reason?: string;
}

export interface DossierRelationEdge {
  readonly relationId?: string;
  readonly source: string;
  readonly target: string;
  readonly sourceKind: string;
  readonly targetKind: string;
  readonly relationType: string;
  readonly rationale?: string;
  readonly workspaceRevision: number;
}

export interface DossierWorkRollup {
  readonly workId: string;
  readonly title: string;
  readonly status: string;
  readonly totalTasks: number;
  readonly doneTasks: number;
  readonly blockedTasks: number;
  readonly activeTasks: number;
  readonly cancelledTasks: number;
  readonly explainerPath: string;
  readonly latestRevision: number;
  readonly recentChildIds: readonly string[];
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
  readonly activeDecisions: Readonly<Record<string, DossierDecisionRecord>>;
  readonly retiredDecisions: readonly DossierDecisionRecord[];
  readonly tasks: Readonly<Record<string, DossierTaskRecord>>;
  readonly relations: readonly DossierRelationEdge[];
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

function refKindOf(ref: string): string {
  if (ref.startsWith("entity-kind/")) {
    const parts = ref.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : ref;
  }
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash) : ref;
}

function entityIdFromRef(ref: string, expectedKind: string): string | null {
  const prefix = `${expectedKind}/`;
  if (!ref.startsWith(prefix)) return null;
  const rest = ref.slice(prefix.length);
  const slash = rest.indexOf("/");
  const id = slash > 0 ? rest.slice(0, slash) : rest;
  return id.length > 0 ? id : null;
}

function resolveKind(rawKind: string, kindMap?: Readonly<Record<string, string>>): string {
  return kindMap?.[rawKind] ?? rawKind;
}

function classifyCategory(change: DossierChangeItem): "task" | "decision" | "fact" | "domain" {
  if (change.schema === "task-event/v1") return "task";
  if (change.schema === "decision-event/v1") return "decision";
  if (change.schema === "fact-event/v1") return "fact";
  return "domain";
}

function extractKinds(
  change: DossierChangeItem,
  slot: DossierSlot,
  kindMap?: Readonly<Record<string, string>>,
): readonly string[] {
  const found = new Set<string>();
  const declared = new Set(slot.entityKinds);

  if (Array.isArray(change.matchedKinds)) {
    for (const kind of change.matchedKinds) {
      const resolved = resolveKind(kind, kindMap);
      if (declared.has(resolved)) found.add(resolved);
    }
  }

  for (const ref of change.entityRefs) {
    const raw = refKindOf(ref);
    const resolved = resolveKind(raw, kindMap);
    if (declared.has(resolved)) found.add(resolved);
  }

  if (found.size === 0 && typeof change.payload.entityKind === "string") {
    const resolved = resolveKind(change.payload.entityKind, kindMap);
    if (declared.has(resolved)) found.add(resolved);
  }

  const category = classifyCategory(change);
  if (found.size === 0 && category !== "domain" && declared.has(category)) {
    found.add(category);
  }

  return [...found];
}

function isRiskEvent(change: DossierChangeItem): boolean {
  return (
    change.payload.taskStatus === "blocked" ||
    change.payload.taskStatus === "cancelled" ||
    change.type === "decision_superseded" ||
    change.type === "decision_retired" ||
    change.type === "task_superseded"
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
          : typeof change.payload.reason === "string"
            ? change.payload.reason
            : null;
  if (candidate && candidate.trim().length > 0) return sanitizeSingleLine(candidate);
  const target = change.entityRefs[0] ?? change.taskId ?? change.decisionId ?? change.eventId;
  return sanitizeSingleLine(`${change.type} (${target})`);
}

function actorOf(change: DossierChangeItem): string {
  return change.actor?.principal?.personId ?? change.actor?.executor?.id ?? "system";
}

function toLedgerEntry(
  change: DossierChangeItem,
  slot: DossierSlot,
  kindMap?: Readonly<Record<string, string>>,
): DossierLedgerEntry {
  return {
    eventId: change.eventId,
    schema: change.schema,
    type: change.type,
    category: classifyCategory(change),
    workspaceRevision: change.workspaceRevision,
    occurredAt: change.occurredAt,
    entityRefs: [...change.entityRefs],
    kinds: extractKinds(change, slot, kindMap),
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
    activeDecisions: {},
    retiredDecisions: [],
    tasks: {},
    relations: [],
  };
}

function parseManagedState(previousBody: string | null, synthesizedAt: string): DossierLedgerState | null {
  if (!previousBody) return null;
  const start = previousBody.lastIndexOf(STATE_COMMENT_PREFIX);
  if (start === -1) return null;
  const end = previousBody.indexOf(STATE_COMMENT_SUFFIX, start + STATE_COMMENT_PREFIX.length);
  if (end === -1) return null;
  const raw = previousBody.slice(start + STATE_COMMENT_PREFIX.length, end).trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  const parsed = JSON.parse(raw) as Partial<DossierLedgerState>;
  if (
    typeof parsed.watermark !== "number" ||
    typeof parsed.totalChanges !== "number" ||
    !parsed.categoryCounts ||
    !Array.isArray(parsed.entries)
  )
    return null;
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
    activeDecisions:
      typeof parsed.activeDecisions === "object" && parsed.activeDecisions !== null ? parsed.activeDecisions : {},
    retiredDecisions: Array.isArray(parsed.retiredDecisions)
      ? parsed.retiredDecisions.slice(0, MAX_RETIRED_DECISIONS)
      : [],
    tasks: typeof parsed.tasks === "object" && parsed.tasks !== null ? parsed.tasks : {},
    relations: Array.isArray(parsed.relations) ? parsed.relations.slice(0, MAX_TRACKED_RELATIONS) : [],
  };
}

function serializeStateComment(state: DossierLedgerState, stripUrls: boolean): string {
  const rawJson = JSON.stringify(state);
  const urlSafe = stripUrls ? sanitizeExternalUrlText(rawJson) : rawJson;
  const safeJson = urlSafe
    .replaceAll("--", "\\u002d\\u002d")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  return `${STATE_COMMENT_PREFIX}${safeJson}${STATE_COMMENT_SUFFIX}`;
}

function stringListFrom(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function extractDecisionId(change: DossierChangeItem): string | null {
  if (typeof change.decisionId === "string" && change.decisionId.length > 0) return change.decisionId;
  if (typeof change.payload.decisionId === "string" && change.payload.decisionId.length > 0)
    return change.payload.decisionId;
  for (const ref of change.entityRefs) {
    const id = entityIdFromRef(ref, "decision");
    if (id) return id;
  }
  return null;
}

function extractTaskId(change: DossierChangeItem): string | null {
  if (typeof change.taskId === "string" && change.taskId.length > 0) return change.taskId;
  if (typeof change.payload.taskId === "string" && change.payload.taskId.length > 0) return change.payload.taskId;
  for (const ref of change.entityRefs) {
    const id = entityIdFromRef(ref, "task");
    if (id) return id;
  }
  return null;
}

function extractRelationEdge(
  change: DossierChangeItem,
  kindMap?: Readonly<Record<string, string>>,
): { readonly retiredId?: string; readonly edge?: DossierRelationEdge } {
  const rel = change.payload.relation as DossierRelationPayload | undefined;
  if (rel && typeof rel === "object") {
    if (rel.state === "retired" && typeof rel.relationId === "string") {
      return { retiredId: rel.relationId };
    }
    if (typeof rel.source === "string" && typeof rel.target === "string" && typeof rel.relationType === "string") {
      return {
        edge: {
          ...(typeof rel.relationId === "string" ? { relationId: rel.relationId } : {}),
          source: rel.source,
          target: rel.target,
          sourceKind: resolveKind(rel.sourceKind ?? refKindOf(rel.source), kindMap),
          targetKind: resolveKind(rel.targetKind ?? refKindOf(rel.target), kindMap),
          relationType: rel.relationType,
          ...(typeof rel.rationale === "string" ? { rationale: sanitizeSingleLine(rel.rationale, 120) } : {}),
          workspaceRevision: change.workspaceRevision,
        },
      };
    }
  }
  if (change.schema === "fact-event/v1" && typeof change.payload.supersedesRef === "string") {
    const source =
      change.entityRefs.find((ref) => ref.startsWith("fact/")) ?? `fact/${change.factId ?? change.eventId}`;
    return {
      edge: {
        source,
        target: change.payload.supersedesRef,
        sourceKind: "fact",
        targetKind: resolveKind(refKindOf(change.payload.supersedesRef), kindMap),
        relationType: "supersedes-fact",
        workspaceRevision: change.workspaceRevision,
      },
    };
  }
  return {};
}

function pruneTasks(tasks: Record<string, DossierTaskRecord>): Record<string, DossierTaskRecord> {
  const all = Object.values(tasks);
  if (all.length <= MAX_TRACKED_TASKS) return tasks;
  const pinned = all.filter((task) => task.taskClass === "work" || task.status === "blocked");
  const pinnedIds = new Set(pinned.map((task) => task.taskId));
  const recent = all
    .filter((task) => !pinnedIds.has(task.taskId))
    .sort((left, right) => right.workspaceRevision - left.workspaceRevision)
    .slice(0, Math.max(0, MAX_TRACKED_TASKS - pinned.length));
  return Object.fromEntries([...pinned, ...recent].map((task) => [task.taskId, task]));
}

function pruneActiveDecisions(decisions: Record<string, DossierDecisionRecord>): Record<string, DossierDecisionRecord> {
  const all = Object.values(decisions);
  if (all.length <= MAX_ACTIVE_DECISIONS) return decisions;
  const kept = all
    .sort((left, right) => right.workspaceRevision - left.workspaceRevision)
    .slice(0, MAX_ACTIVE_DECISIONS);
  return Object.fromEntries(kept.map((item) => [item.decisionId, item]));
}

function applyStructuredUpdate(
  change: DossierChangeItem,
  entry: DossierLedgerEntry,
  activeDecisions: Record<string, DossierDecisionRecord>,
  retiredDecisions: DossierDecisionRecord[],
  tasks: Record<string, DossierTaskRecord>,
  relations: DossierRelationEdge[],
  kindMap?: Readonly<Record<string, string>>,
): void {
  if (change.schema === "decision-event/v1") {
    const decisionId = extractDecisionId(change);
    if (decisionId) {
      const existing = activeDecisions[decisionId];
      const title =
        typeof change.payload.title === "string" && change.payload.title.trim().length > 0
          ? sanitizeSingleLine(change.payload.title)
          : (existing?.title ?? entry.summary);
      const reason = typeof change.payload.reason === "string" ? sanitizeSingleLine(change.payload.reason) : undefined;
      const modules = stringListFrom(change.payload.modules);
      const mergedModules = modules.length > 0 ? modules : (existing?.modules ?? []);

      if (change.type === "decision_superseded" || change.type === "decision_retired") {
        delete activeDecisions[decisionId];
        const retiredState = change.type === "decision_superseded" ? "superseded" : "retired";
        const idx = retiredDecisions.findIndex((item) => item.decisionId === decisionId);
        if (idx >= 0) retiredDecisions.splice(idx, 1);
        retiredDecisions.unshift({
          decisionId,
          title,
          state: retiredState,
          workspaceRevision: change.workspaceRevision,
          occurredAt: change.occurredAt,
          actorLabel: entry.actorLabel,
          ...(reason ? { reason } : {}),
          modules: mergedModules,
          derivedTaskIds: existing?.derivedTaskIds ?? [],
        });
      } else if (
        change.type === "decision_accepted" ||
        change.type === "decision_amended" ||
        change.type === "decision_repinned"
      ) {
        activeDecisions[decisionId] = {
          decisionId,
          title,
          state: "in_effect",
          workspaceRevision: change.workspaceRevision,
          occurredAt: change.occurredAt,
          actorLabel: entry.actorLabel,
          ...(reason ? { reason } : existing?.reason ? { reason: existing.reason } : {}),
          modules: mergedModules,
          derivedTaskIds: existing?.derivedTaskIds ?? [],
        };
      }
    }
  }

  if (change.schema === "task-event/v1") {
    const taskId = extractTaskId(change);
    if (taskId) {
      const existing = tasks[taskId];
      const rawClass = change.payload.taskClass;
      const taskClass: DossierTaskRecord["taskClass"] =
        rawClass === "work" || rawClass === "standard" || rawClass === "long_running"
          ? rawClass
          : (existing?.taskClass ?? "standard");
      const status =
        typeof change.payload.taskStatus === "string" && change.payload.taskStatus.length > 0
          ? change.payload.taskStatus
          : change.type === "task_completed"
            ? "done"
            : change.type === "task_superseded"
              ? "cancelled"
              : (existing?.status ?? "planned");
      const parentTaskId =
        change.payload.parentTaskId === null
          ? null
          : typeof change.payload.parentTaskId === "string" && change.payload.parentTaskId.length > 0
            ? change.payload.parentTaskId
            : (existing?.parentTaskId ?? null);
      const surfaces = stringListFrom(change.payload.surfaces);
      const title =
        typeof change.payload.title === "string" && change.payload.title.trim().length > 0
          ? sanitizeSingleLine(change.payload.title)
          : (existing?.title ?? entry.summary);
      const reason =
        status === "blocked" || status === "cancelled"
          ? typeof change.payload.reason === "string"
            ? sanitizeSingleLine(change.payload.reason)
            : existing?.reason
          : undefined;
      tasks[taskId] = {
        taskId,
        title,
        taskClass,
        status,
        parentTaskId,
        surfaces: surfaces.length > 0 ? surfaces : (existing?.surfaces ?? []),
        workspaceRevision: change.workspaceRevision,
        occurredAt: change.occurredAt,
        actorLabel: entry.actorLabel,
        ...(reason ? { reason } : {}),
      };
    }
  }

  const { retiredId, edge } = extractRelationEdge(change, kindMap);
  if (retiredId) {
    const idx = relations.findIndex((item) => item.relationId === retiredId);
    if (idx >= 0) relations.splice(idx, 1);
  }
  if (edge) {
    const existingIdx = relations.findIndex(
      (item) =>
        (edge.relationId && item.relationId === edge.relationId) ||
        (item.source === edge.source && item.target === edge.target && item.relationType === edge.relationType),
    );
    if (existingIdx >= 0) relations.splice(existingIdx, 1);
    relations.unshift(edge);

    // Link Decision -> Task causal derivation directly onto activeDecisions.
    const decFromSource = entityIdFromRef(edge.source, "decision");
    const taskFromTarget = entityIdFromRef(edge.target, "task");
    const taskFromSource = entityIdFromRef(edge.source, "task");
    const decFromTarget = entityIdFromRef(edge.target, "decision");
    const decisionId = decFromSource ?? decFromTarget;
    const taskId = taskFromTarget ?? taskFromSource;
    if (decisionId && taskId && activeDecisions[decisionId]) {
      const current = activeDecisions[decisionId]!;
      if (!current.derivedTaskIds.includes(taskId)) {
        activeDecisions[decisionId] = {
          ...current,
          derivedTaskIds: [...current.derivedTaskIds, taskId],
        };
      }
    }
  }
}

function mergeLedgerState(input: DossierSynthesisInput, prior: DossierLedgerState): DossierLedgerState {
  const seen = new Set(prior.entries.map((entry) => entry.eventId));
  const categoryCounts = { ...prior.categoryCounts };
  const kindCounts: Record<string, number> = { ...prior.kindCounts };
  const activeDecisions: Record<string, DossierDecisionRecord> = { ...prior.activeDecisions };
  const retiredDecisions: DossierDecisionRecord[] = [...prior.retiredDecisions];
  const tasks: Record<string, DossierTaskRecord> = { ...prior.tasks };
  const relations: DossierRelationEdge[] = [...prior.relations];
  const incoming: DossierLedgerEntry[] = [];

  // Process chronologically so state transitions (accept->supersede, blocked->active/done) resolve accurately.
  const ordered = [...input.changes].sort(
    (left, right) => left.workspaceRevision - right.workspaceRevision || left.eventId.localeCompare(right.eventId),
  );
  for (const change of ordered) {
    if (seen.has(change.eventId)) continue;
    seen.add(change.eventId);
    const entry = toLedgerEntry(change, input.slot, input.kindMap);
    incoming.push(entry);
    categoryCounts[entry.category] += 1;
    for (const kind of entry.kinds) kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    applyStructuredUpdate(change, entry, activeDecisions, retiredDecisions, tasks, relations, input.kindMap);
  }

  const mergedEntries = [...incoming, ...prior.entries]
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
    entries: mergedEntries,
    activeDecisions: pruneActiveDecisions(activeDecisions),
    retiredDecisions: retiredDecisions.slice(0, MAX_RETIRED_DECISIONS),
    tasks: pruneTasks(tasks),
    relations: relations.slice(0, MAX_TRACKED_RELATIONS),
  };
}

function activeBlockedTasks(state: DossierLedgerState): readonly DossierTaskRecord[] {
  return Object.values(state.tasks)
    .filter((task) => task.status === "blocked")
    .sort((left, right) => right.workspaceRevision - left.workspaceRevision);
}

function computeWorkRollups(state: DossierLedgerState): readonly DossierWorkRollup[] {
  const taskMap = state.tasks;
  const workIds = new Set<string>();
  for (const task of Object.values(taskMap)) {
    if (task.taskClass === "work") workIds.add(task.taskId);
    if (task.parentTaskId) {
      let ancestor: string | null = task.parentTaskId;
      const visited = new Set<string>([task.taskId]);
      while (ancestor && !visited.has(ancestor)) {
        visited.add(ancestor);
        const parent: DossierTaskRecord | undefined = taskMap[ancestor];
        if (!parent || parent.taskClass === "work" || parent.parentTaskId === null) {
          workIds.add(ancestor);
          break;
        }
        ancestor = parent.parentTaskId;
      }
    }
  }

  const childrenByWork = new Map<string, DossierTaskRecord[]>();
  for (const id of workIds) childrenByWork.set(id, []);

  for (const task of Object.values(taskMap)) {
    if (!task.parentTaskId) continue;
    let cursor: string | null = task.parentTaskId;
    const visited = new Set<string>([task.taskId]);
    let rootId: string | null = null;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      if (workIds.has(cursor)) rootId = cursor;
      const parentTask: DossierTaskRecord | undefined = taskMap[cursor];
      cursor = parentTask?.parentTaskId ?? null;
    }
    if (rootId) childrenByWork.get(rootId)?.push(task);
  }

  const rollups: DossierWorkRollup[] = [];
  for (const workId of workIds) {
    const workRecord = taskMap[workId];
    const children = (childrenByWork.get(workId) ?? []).sort(
      (left, right) => right.workspaceRevision - left.workspaceRevision,
    );
    const doneTasks = children.filter((child) => child.status === "done").length;
    const blockedTasks = children.filter((child) => child.status === "blocked").length;
    const cancelledTasks = children.filter((child) => child.status === "cancelled").length;
    const activeTasks = children.length - doneTasks - blockedTasks - cancelledTasks;
    const latestRevision = Math.max(
      workRecord?.workspaceRevision ?? 0,
      ...children.map((child) => child.workspaceRevision),
    );
    rollups.push({
      workId,
      title: workRecord?.title ?? workId,
      status:
        workRecord?.status ??
        (blockedTasks > 0 ? "blocked" : children.length > 0 && doneTasks === children.length ? "done" : "active"),
      totalTasks: children.length,
      doneTasks,
      blockedTasks,
      activeTasks,
      cancelledTasks,
      explainerPath: `tasks/${workId}/artifacts/explainer.html`,
      latestRevision,
      recentChildIds: children.slice(0, 6).map((child) => child.taskId),
    });
  }

  return rollups.sort(
    (left, right) => right.latestRevision - left.latestRevision || left.workId.localeCompare(right.workId),
  );
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "/").replace(/\r?\n/gu, " ");
}

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
    const detail = dec.reason && dec.reason !== dec.title ? `${dec.title} — ${dec.reason}` : dec.title;
    lines.push(
      `| r${dec.workspaceRevision} | \`decision/${escapeMarkdownCell(dec.decisionId)}\` | \`${dec.state}\` | ${escapeMarkdownCell(detail)} | ${escapeMarkdownCell(scopeParts.join(" · ") || "—")} |`,
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
          `| \`${escapeMarkdownCell(work.workId)}\` | ${escapeMarkdownCell(work.title)} | \`${work.status}\` | ${work.doneTasks}/${work.totalTasks} | ${work.blockedTasks} | \`${work.explainerPath}\` | r${work.latestRevision} |`,
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

function updateMarkdownWatermarkHeader(body: string, targetWatermark: number): string {
  const watermarkLine = `<!-- dossier-watermark: ${targetWatermark} -->`;
  if (/^\s*<!--\s*dossier-watermark:\s*\d+\s*-->/u.test(body)) {
    return body.replace(/^\s*<!--\s*dossier-watermark:\s*\d+\s*-->/u, watermarkLine);
  }
  return `${watermarkLine}\n${body}`;
}

function preserveExternalMarkdownBody(input: DossierSynthesisInput, previousBody: string): string {
  const withWatermark = updateMarkdownWatermarkHeader(previousBody, input.targetWatermark);
  if (input.changes.length === 0) return withWatermark;

  const entries = input.changes
    .map((change) => toLedgerEntry(change, input.slot, input.kindMap))
    .slice(0, MAX_STORED_ENTRIES);
  const rowLines = entries.map((row) => {
    const refs = row.entityRefs.join(", ") || row.eventId;
    return `| r${row.workspaceRevision} | \`${row.type}\` | \`${escapeMarkdownCell(refs)}\` | ${escapeMarkdownCell(row.summary)} | \`${escapeMarkdownCell(row.actorLabel)}\` |`;
  });

  const existingStart = withWatermark.indexOf(INCREMENTAL_MD_START);
  const existingEnd = withWatermark.indexOf(INCREMENTAL_MD_END);
  if (existingStart !== -1 && existingEnd > existingStart) {
    const existingBlock = withWatermark.slice(existingStart, existingEnd);
    const existingRows = existingBlock
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("| r"))
      .slice(0, Math.max(0, MAX_STORED_ENTRIES - rowLines.length));
    const rebuilt = [
      INCREMENTAL_MD_START,
      `## Incremental Updates (through r${input.targetWatermark})`,
      "",
      "| Rev | Event | Entities | Summary | Actor |",
      "| --- | --- | --- | --- | --- |",
      ...rowLines,
      ...existingRows,
      INCREMENTAL_MD_END,
    ].join("\n");
    return `${withWatermark.slice(0, existingStart)}${rebuilt}${withWatermark.slice(existingEnd + INCREMENTAL_MD_END.length)}`;
  }

  const appendix = [
    "",
    INCREMENTAL_MD_START,
    `## Incremental Updates (r${input.expectedWatermark} -> r${input.targetWatermark})`,
    "",
    "| Rev | Event | Entities | Summary | Actor |",
    "| --- | --- | --- | --- | --- |",
    ...rowLines,
    INCREMENTAL_MD_END,
    "",
  ].join("\n");
  return `${withWatermark.trimEnd()}\n${appendix}`;
}

function escapeInlineHtmlText(value: string): string {
  return sanitizeExternalUrlText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function updateHtmlWatermarkMeta(body: string, targetWatermark: number): string {
  const replacement = `<meta name="dossier-watermark" content="${targetWatermark}">`;
  const nameFirst = /<meta\b[^>]*\bname\s*=\s*(?:"dossier-watermark"|'dossier-watermark'|dossier-watermark)[^>]*>/iu;
  if (nameFirst.test(body)) {
    return body.replace(nameFirst, replacement);
  }
  return body.replace(/<head(\s[^>]*)?>/iu, (match) => `${match}\n${replacement}`);
}

function preserveExternalHtmlBody(input: DossierSynthesisInput, previousBody: string): string {
  const withWatermark = updateHtmlWatermarkMeta(previousBody, input.targetWatermark);
  if (input.changes.length === 0) return withWatermark;

  const entries = input.changes.map((change) => toLedgerEntry(change, input.slot, input.kindMap));
  const newRowsHtml = entries
    .map(
      (entry) =>
        `<tr>` +
        `<td class="rev">r${entry.workspaceRevision}</td>` +
        `<td><code>${escapeInlineHtmlText(entry.type)}</code></td>` +
        `<td class="refs">${escapeInlineHtmlText(entry.entityRefs.join(", ") || entry.eventId)}</td>` +
        `<td>${escapeInlineHtmlText(entry.summary)}</td>` +
        `<td class="time">${escapeInlineHtmlText(entry.occurredAt.slice(0, 19).replace("T", " "))}</td>` +
        `</tr>`,
    )
    .join("");

  const incrementalMarker =
    /(<section\b[^>]*data-dossier-incremental="true"[^>]*>[\s\S]*?<tbody>)([\s\S]*?)(<\/tbody>)/iu;
  if (incrementalMarker.test(withWatermark)) {
    return withWatermark.replace(
      incrementalMarker,
      (_match, open: string, existing: string, close: string) => `${open}${newRowsHtml}${existing}${close}`,
    );
  }

  const incrementalSection =
    `\n<section data-dossier-incremental="true">` +
    `<h2>Incremental Updates <small>r${input.expectedWatermark}→r${input.targetWatermark}</small></h2>` +
    `<div class="table-wrap"><table><thead><tr><th>Rev</th><th>Event</th><th>Entities</th><th>Summary</th><th>Time</th></tr></thead>` +
    `<tbody>${newRowsHtml}</tbody></table></div></section>\n`;

  if (/<\/main\s*>/iu.test(withWatermark)) {
    return withWatermark.replace(/<\/main\s*>/iu, () => `${incrementalSection}</main>`);
  }
  if (/<\/body\s*>/iu.test(withWatermark)) {
    return withWatermark.replace(/<\/body\s*>/iu, () => `${incrementalSection}</body>`);
  }
  return `${withWatermark}${incrementalSection}`;
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
