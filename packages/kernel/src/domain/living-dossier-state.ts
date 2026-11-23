import type { DecisionState } from "./decision-event-types.ts";
import {
  MAX_ARCHIVED_TASK_INDEX,
  MAX_BLOCKED_PINNED,
  MAX_PINNED_WORKS,
  MAX_TRACKED_TASKS,
  MAX_WORK_COUNTERS,
  pruneByRevision,
  pruneTasks,
  pruneWorkCounters,
  reclaimArchivedChildTask,
  resolveRootWorkId,
  trimArchivedTaskStates,
  type ArchivedTaskBucket,
  type DossierTaskRecord,
  type DossierWorkCounter,
} from "./living-dossier-compaction.ts";
import type { DossierSlot } from "./living-dossier.ts";
import type { TaskClass } from "./task.ts";

export { resolveRootWorkId, type ArchivedTaskBucket, type DossierTaskRecord, type DossierWorkCounter };

const STATE_COMMENT_PREFIX = "<!-- dossier-state:v1 ";
const STATE_COMMENT_SUFFIX = " -->";
const MAX_STORED_ENTRIES = 48;
const MAX_ACTIVE_DECISIONS = 256;
const MAX_PENDING_PROPOSALS = 128;
const MAX_RETIRED_DECISIONS = 48;
const MAX_TRACKED_RELATIONS = 64;

interface DossierRelationPayload {
  readonly relationId?: string;
  readonly previousRelationId?: string;
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

export interface DossierDerivedLink {
  readonly relationId?: string;
  readonly taskId: string;
}

export interface DossierProposalMeta {
  readonly decisionId: string;
  readonly title: string;
  readonly chosen: readonly string[];
  readonly modules: readonly string[];
  readonly derivedLinks?: readonly DossierDerivedLink[];
  readonly workspaceRevision: number;
}

export interface DossierDecisionRecord {
  readonly decisionId: string;
  readonly title: string;
  readonly state: DecisionState;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
  readonly actorLabel: string;
  readonly reason?: string;
  readonly chosen?: readonly string[];
  readonly modules: readonly string[];
  readonly derivedLinks?: readonly DossierDerivedLink[];
  readonly derivedTaskIds: readonly string[];
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
  readonly pendingProposals: Readonly<Record<string, DossierProposalMeta>>;
  readonly activeDecisions: Readonly<Record<string, DossierDecisionRecord>>;
  readonly retiredDecisions: readonly DossierDecisionRecord[];
  readonly tasks: Readonly<Record<string, DossierTaskRecord>>;
  readonly workCounters: Readonly<Record<string, DossierWorkCounter>>;
  readonly workCountersTruncated?: boolean;
  readonly blockedTruncated?: boolean;
  readonly relations: ReadonlyArray<DossierRelationEdge>;
}

const EXTERNAL_SCHEME_PREFIX_RE = /\b[a-z][a-z0-9+.-]{1,31}:(?:\/\/|\\\/\\\/)(?=[^\s"'<>`])/giu;
const EXTERNAL_CONTACT_URI_RE = /\b(?:mailto|tel|webcal|callto|sip|sips|xmpp):([^\s"'<>`]+)/giu;
const PROTOCOL_RELATIVE_URL_RE =
  /(^|[\s(>[{"'`=,;])\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:[:/?#][^\s"'<>`]*)?)/giu;

/** Fixed-point removal of external URI schemes so offline HTML stays 100% free of external URLs while keeping readable clues. */
export function sanitizeExternalUrlText(value: string): string {
  let current = value;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = current
      .replace(EXTERNAL_SCHEME_PREFIX_RE, "")
      .replace(EXTERNAL_CONTACT_URI_RE, "$1")
      .replace(PROTOCOL_RELATIVE_URL_RE, "$1$2");
    if (next === current) break;
    current = next;
  }
  return current;
}

export function sanitizeSingleLine(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function refKindOf(ref: string): string {
  if (ref.startsWith("entity-kind/")) {
    const parts = ref.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : ref;
  }
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash) : ref;
}

export function entityIdFromRef(ref: string, expectedKind: string): string | null {
  const prefix = `${expectedKind}/`;
  if (!ref.startsWith(prefix)) return null;
  const rest = ref.slice(prefix.length);
  const slash = rest.indexOf("/");
  const id = slash > 0 ? rest.slice(0, slash) : rest;
  return id.length > 0 ? id : null;
}

export function resolveKind(rawKind: string, kindMap?: Readonly<Record<string, string>>): string {
  return kindMap?.[rawKind] ?? rawKind;
}

function classifyCategory(change: DossierChangeItem): "task" | "decision" | "fact" | "domain" {
  if (change.schema === "task-event/v1" || (change.schema === "dossier-bootstrap/v1" && change.type === "seed_task"))
    return "task";
  if (
    change.schema === "decision-event/v1" ||
    (change.schema === "dossier-bootstrap/v1" && change.type === "seed_decision")
  )
    return "decision";
  if (change.schema === "fact-event/v1" || (change.schema === "dossier-bootstrap/v1" && change.type === "seed_fact"))
    return "fact";
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
    change.payload.decisionAction === "superseded" ||
    change.payload.decisionAction === "retired" ||
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

export function toLedgerEntry(
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

export function parseManagedState(previousBody: string | null, synthesizedAt: string): DossierLedgerState | null {
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
  const parsedRelations = Array.isArray(parsed.relations) ? parsed.relations.slice(0, MAX_TRACKED_RELATIONS) : [];
  const rawActiveDecisions =
    typeof parsed.activeDecisions === "object" && parsed.activeDecisions !== null ? parsed.activeDecisions : {};
  const hydratedActiveDecisions: Record<string, DossierDecisionRecord> = {};
  for (const [decisionId, record] of Object.entries(rawActiveDecisions)) {
    const derivedLinks = normalizeDerivedLinks(record, decisionId, parsedRelations);
    hydratedActiveDecisions[decisionId] = {
      ...record,
      ...(derivedLinks.length > 0 ? { derivedLinks } : {}),
      derivedTaskIds: derivedTaskIdsFromLinks(derivedLinks),
    };
  }
  const rawCounters =
    typeof parsed.workCounters === "object" && parsed.workCounters !== null ? parsed.workCounters : {};
  const hydratedCounters: Record<string, DossierWorkCounter> = {};
  let legacyBlockedDropped = false;
  for (const [workId, rawCounter] of Object.entries(rawCounters)) {
    const normalized = trimArchivedTaskStates(rawCounter, MAX_ARCHIVED_TASK_INDEX);
    hydratedCounters[workId] = normalized.counter;
    if (normalized.blockedIndexDropped) legacyBlockedDropped = true;
  }
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
    pendingProposals:
      typeof parsed.pendingProposals === "object" && parsed.pendingProposals !== null ? parsed.pendingProposals : {},
    activeDecisions: hydratedActiveDecisions,
    retiredDecisions: Array.isArray(parsed.retiredDecisions)
      ? parsed.retiredDecisions.slice(0, MAX_RETIRED_DECISIONS)
      : [],
    tasks: typeof parsed.tasks === "object" && parsed.tasks !== null ? parsed.tasks : {},
    workCounters: hydratedCounters,
    ...(parsed.workCountersTruncated ? { workCountersTruncated: true } : {}),
    ...(parsed.blockedTruncated || legacyBlockedDropped ? { blockedTruncated: true } : {}),
    relations: parsedRelations,
  };
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

function extractRelationUpdate(
  change: DossierChangeItem,
  kindMap?: Readonly<Record<string, string>>,
): { readonly retiredIds: readonly string[]; readonly edge?: DossierRelationEdge } {
  const rel = change.payload.relation as DossierRelationPayload | undefined;
  const retiredIds: string[] = [];
  if (rel && typeof rel === "object") {
    if (typeof rel.previousRelationId === "string" && rel.previousRelationId.length > 0) {
      retiredIds.push(rel.previousRelationId);
    }
    if (rel.state === "retired" && typeof rel.relationId === "string" && rel.relationId.length > 0) {
      retiredIds.push(rel.relationId);
      return { retiredIds };
    }
    if (typeof rel.source === "string" && typeof rel.target === "string" && typeof rel.relationType === "string") {
      return {
        retiredIds,
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
      retiredIds,
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
  return { retiredIds };
}

function decisionTaskLinkOf(
  edge: DossierRelationEdge,
): { readonly decisionId: string; readonly taskId: string } | null {
  const decisionId = entityIdFromRef(edge.source, "decision") ?? entityIdFromRef(edge.target, "decision");
  const taskId = entityIdFromRef(edge.target, "task") ?? entityIdFromRef(edge.source, "task");
  return decisionId && taskId ? { decisionId, taskId } : null;
}

function derivedTaskIdsFromLinks(links: readonly DossierDerivedLink[]): readonly string[] {
  return [...new Set(links.map((item) => item.taskId))];
}

function normalizeDerivedLinks(
  record:
    | { readonly derivedLinks?: readonly DossierDerivedLink[]; readonly derivedTaskIds?: readonly string[] }
    | undefined,
  decisionId: string,
  relations: readonly DossierRelationEdge[],
): readonly DossierDerivedLink[] {
  if (Array.isArray(record?.derivedLinks)) return record.derivedLinks;
  const legacyIds = Array.isArray(record?.derivedTaskIds) ? record.derivedTaskIds : [];
  if (legacyIds.length === 0) return [];
  const links: DossierDerivedLink[] = [];
  const matched = new Set<string>();
  for (const edge of relations) {
    const link = decisionTaskLinkOf(edge);
    if (link && link.decisionId === decisionId && legacyIds.includes(link.taskId)) {
      links.push({ ...(edge.relationId ? { relationId: edge.relationId } : {}), taskId: link.taskId });
      matched.add(link.taskId);
    }
  }
  for (const taskId of legacyIds) {
    if (!matched.has(taskId)) links.push({ taskId });
  }
  return links;
}

function upsertDerivedLink(
  links: readonly DossierDerivedLink[],
  incoming: DossierDerivedLink,
): readonly DossierDerivedLink[] {
  const filtered = incoming.relationId
    ? links.filter((item) => item.relationId !== incoming.relationId)
    : links.filter((item) => item.relationId !== undefined || item.taskId !== incoming.taskId);
  return [...filtered, incoming];
}

function applyStructuredUpdate(
  change: DossierChangeItem,
  entry: DossierLedgerEntry,
  pendingProposals: Record<string, DossierProposalMeta>,
  activeDecisions: Record<string, DossierDecisionRecord>,
  retiredDecisions: DossierDecisionRecord[],
  tasks: Record<string, DossierTaskRecord>,
  workCounters: Record<string, DossierWorkCounter>,
  relations: DossierRelationEdge[],
  workCountersTruncated: boolean,
  kindMap?: Readonly<Record<string, string>>,
): { readonly retiredMatched: boolean } {
  if (
    change.schema === "decision-event/v1" ||
    (change.schema === "dossier-bootstrap/v1" && change.type === "seed_decision")
  ) {
    const decisionId = extractDecisionId(change);
    if (decisionId) {
      const existing = activeDecisions[decisionId];
      const proposal = pendingProposals[decisionId];
      const payloadTitle =
        typeof change.payload.title === "string" && change.payload.title.trim().length > 0
          ? sanitizeSingleLine(change.payload.title)
          : undefined;
      const title = payloadTitle ?? existing?.title ?? proposal?.title ?? entry.summary;
      const reason = typeof change.payload.reason === "string" ? sanitizeSingleLine(change.payload.reason) : undefined;
      const payloadModules = stringListFrom(change.payload.modules);
      const mergedModules = payloadModules.length > 0 ? payloadModules : (existing?.modules ?? proposal?.modules ?? []);
      const payloadChosen = stringListFrom(change.payload.chosen);
      const mergedChosen = payloadChosen.length > 0 ? payloadChosen : (existing?.chosen ?? proposal?.chosen ?? []);

      const mergedDerivedLinks = existing
        ? normalizeDerivedLinks(existing, decisionId, relations)
        : normalizeDerivedLinks(proposal, decisionId, relations);

      const buildProposal = (): DossierProposalMeta => ({
        decisionId,
        title,
        chosen: mergedChosen,
        modules: mergedModules,
        ...(mergedDerivedLinks.length > 0 ? { derivedLinks: mergedDerivedLinks } : {}),
        workspaceRevision: change.workspaceRevision,
      });
      const buildRecord = (state: DecisionState, effectiveReason?: string): DossierDecisionRecord => ({
        decisionId,
        title,
        state,
        workspaceRevision: change.workspaceRevision,
        occurredAt: change.occurredAt,
        actorLabel: entry.actorLabel,
        ...(effectiveReason ? { reason: effectiveReason } : {}),
        ...(mergedChosen.length > 0 ? { chosen: mergedChosen } : {}),
        modules: mergedModules,
        ...(mergedDerivedLinks.length > 0 ? { derivedLinks: mergedDerivedLinks } : {}),
        derivedTaskIds: derivedTaskIdsFromLinks(mergedDerivedLinks),
      });

      const action = typeof change.payload.decisionAction === "string" ? change.payload.decisionAction : null;
      if (change.type === "decision_proposed" || action === "proposed") {
        pendingProposals[decisionId] = buildProposal();
      } else if (
        change.type === "decision_rejected" ||
        change.type === "decision_deferred" ||
        action === "rejected" ||
        action === "deferred"
      ) {
        delete pendingProposals[decisionId];
      } else if (
        change.type === "decision_superseded" ||
        change.type === "decision_retired" ||
        action === "superseded" ||
        action === "retired"
      ) {
        delete activeDecisions[decisionId];
        delete pendingProposals[decisionId];
        const retiredState: DecisionState =
          change.type === "decision_superseded" || action === "superseded" ? "superseded" : "outcome_retired";
        const idx = retiredDecisions.findIndex((item) => item.decisionId === decisionId);
        if (idx >= 0) retiredDecisions.splice(idx, 1);
        retiredDecisions.unshift(buildRecord(retiredState, reason));
      } else if (
        change.type === "decision_accepted" ||
        change.type === "decision_amended" ||
        change.type === "decision_repinned" ||
        action === "accepted"
      ) {
        if (change.type === "decision_amended" && !existing && proposal) {
          pendingProposals[decisionId] = buildProposal();
        } else {
          delete pendingProposals[decisionId];
          activeDecisions[decisionId] = buildRecord("in_effect", reason ?? existing?.reason);
        }
      }
    }
  }

  if (change.schema === "task-event/v1" || (change.schema === "dossier-bootstrap/v1" && change.type === "seed_task")) {
    const taskId = extractTaskId(change);
    if (taskId) {
      const existing = tasks[taskId];
      const reclaimedWorkId = reclaimArchivedChildTask(taskId, workCounters);
      const rawClass = change.payload.taskClass;
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
            : (existing?.parentTaskId ?? reclaimedWorkId ?? null);
      const packagePath =
        typeof change.payload.packagePath === "string" && change.payload.packagePath.trim().length > 0
          ? change.payload.packagePath.trim()
          : existing?.packagePath;
      const surfaces = stringListFrom(change.payload.surfaces);
      const reason =
        status === "blocked" || status === "cancelled"
          ? typeof change.payload.reason === "string"
            ? sanitizeSingleLine(change.payload.reason)
            : existing?.reason
          : undefined;
      if (parentTaskId) {
        const rootWorkId = resolveRootWorkId({ taskId, parentTaskId }, tasks, workCounters);
        if (rootWorkId && !workCounters[rootWorkId] && !tasks[rootWorkId] && workCountersTruncated) {
          workCounters[rootWorkId] = {
            archivedTotal: 0,
            archivedDone: 0,
            archivedBlocked: 0,
            archivedActive: 0,
            archivedCancelled: 0,
            latestRevision: change.workspaceRevision,
            countsIncomplete: true,
          };
        }
      }
      const priorCounter = workCounters[taskId];
      const inferredClass: TaskClass =
        rawClass === "work" || rawClass === "standard" || rawClass === "long_running"
          ? rawClass
          : (existing?.taskClass ?? (priorCounter && parentTaskId === null ? "work" : "standard"));
      const resolvedPackagePath = packagePath ?? priorCounter?.packagePath;
      const resolvedTitle =
        typeof change.payload.title === "string" && change.payload.title.trim().length > 0
          ? sanitizeSingleLine(change.payload.title)
          : (existing?.title ?? priorCounter?.title ?? entry.summary);
      const countsIncomplete = Boolean(
        existing?.countsIncomplete ||
          priorCounter?.countsIncomplete ||
          (!existing &&
            change.type !== "task_created" &&
            change.type !== "seed_task" &&
            inferredClass === "work" &&
            !priorCounter &&
            workCountersTruncated),
      );
      tasks[taskId] = {
        taskId,
        title: resolvedTitle,
        taskClass: inferredClass,
        status,
        parentTaskId,
        ...(resolvedPackagePath ? { packagePath: resolvedPackagePath } : {}),
        surfaces: surfaces.length > 0 ? surfaces : (existing?.surfaces ?? []),
        workspaceRevision: change.workspaceRevision,
        occurredAt: change.occurredAt,
        actorLabel: entry.actorLabel,
        ...(reason ? { reason } : {}),
        ...(countsIncomplete ? { countsIncomplete: true } : {}),
      };
    }
  }

  let retiredMatched = false;
  const { retiredIds, edge } = extractRelationUpdate(change, kindMap);
  for (const retiredId of retiredIds) {
    const idx = relations.findIndex((item) => item.relationId === retiredId);
    if (idx >= 0) {
      relations.splice(idx, 1);
      retiredMatched = true;
    }
    for (const [decId, current] of Object.entries(activeDecisions)) {
      const links = normalizeDerivedLinks(current, decId, relations);
      const nextLinks = links.filter((item) => item.relationId !== retiredId);
      if (nextLinks.length !== links.length) {
        retiredMatched = true;
        activeDecisions[decId] = {
          ...current,
          derivedLinks: nextLinks,
          derivedTaskIds: derivedTaskIdsFromLinks(nextLinks),
        };
      }
    }
    for (const [decId, proposal] of Object.entries(pendingProposals)) {
      const links = proposal.derivedLinks ?? [];
      const nextLinks = links.filter((item) => item.relationId !== retiredId);
      if (nextLinks.length !== links.length) {
        retiredMatched = true;
        pendingProposals[decId] = { ...proposal, derivedLinks: nextLinks };
      }
    }
  }
  if (edge) {
    const existingIdx = relations.findIndex(
      (item) =>
        (edge.relationId && item.relationId === edge.relationId) ||
        (item.source === edge.source && item.target === edge.target && item.relationType === edge.relationType),
    );
    if (existingIdx >= 0) relations.splice(existingIdx, 1);
    relations.unshift(edge);

    const link = decisionTaskLinkOf(edge);
    if (link) {
      const incomingLink: DossierDerivedLink = {
        ...(edge.relationId ? { relationId: edge.relationId } : {}),
        taskId: link.taskId,
      };
      if (activeDecisions[link.decisionId]) {
        const current = activeDecisions[link.decisionId]!;
        const nextLinks = upsertDerivedLink(normalizeDerivedLinks(current, link.decisionId, relations), incomingLink);
        activeDecisions[link.decisionId] = {
          ...current,
          derivedLinks: nextLinks,
          derivedTaskIds: derivedTaskIdsFromLinks(nextLinks),
        };
      } else if (pendingProposals[link.decisionId]) {
        const proposal = pendingProposals[link.decisionId]!;
        pendingProposals[link.decisionId] = {
          ...proposal,
          derivedLinks: upsertDerivedLink(proposal.derivedLinks ?? [], incomingLink),
        };
      }
    }
  }
  return { retiredMatched };
}

export function mergeLedgerState(input: DossierSynthesisInput, prior: DossierLedgerState): DossierLedgerState {
  const seen = new Set(prior.entries.map((entry) => entry.eventId));
  const categoryCounts = { ...prior.categoryCounts };
  const kindCounts: Record<string, number> = { ...prior.kindCounts };
  const pendingProposals: Record<string, DossierProposalMeta> = { ...prior.pendingProposals };
  const activeDecisions: Record<string, DossierDecisionRecord> = { ...prior.activeDecisions };
  const retiredDecisions: DossierDecisionRecord[] = [...prior.retiredDecisions];
  const tasks: Record<string, DossierTaskRecord> = { ...prior.tasks };
  const workCounters: Record<string, DossierWorkCounter> = { ...prior.workCounters };
  const relations: DossierRelationEdge[] = [...prior.relations];
  const incoming: DossierLedgerEntry[] = [];

  const ordered = [...input.changes].sort(
    (left, right) => left.workspaceRevision - right.workspaceRevision || left.eventId.localeCompare(right.eventId),
  );
  for (const change of ordered) {
    if (seen.has(change.eventId)) continue;
    seen.add(change.eventId);
    const entry = toLedgerEntry(change, input.slot, input.kindMap);
    const { retiredMatched } = applyStructuredUpdate(
      change,
      entry,
      pendingProposals,
      activeDecisions,
      retiredDecisions,
      tasks,
      workCounters,
      relations,
      Boolean(prior.workCountersTruncated),
      input.kindMap,
    );
    // Skip logging relation_retired noise on slots that neither track that edge nor declare "relation".
    if (change.type === "relation_retired" && !retiredMatched && !input.slot.entityKinds.includes("relation")) {
      continue;
    }
    incoming.push(entry);
    categoryCounts[entry.category] += 1;
    for (const kind of entry.kinds) kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
  }

  const mergedEntries = [...incoming, ...prior.entries]
    .sort(
      (left, right) => right.workspaceRevision - left.workspaceRevision || right.eventId.localeCompare(left.eventId),
    )
    .slice(0, MAX_STORED_ENTRIES);

  return compactDossierState(
    {
      watermark: input.targetWatermark,
      synthesizedAt: input.synthesizedAt,
      totalChanges: prior.totalChanges + incoming.length,
      categoryCounts,
      kindCounts,
      entries: mergedEntries,
      pendingProposals,
      activeDecisions,
      retiredDecisions,
      tasks,
      workCounters,
      ...(prior.workCountersTruncated ? { workCountersTruncated: true } : {}),
      ...(prior.blockedTruncated ? { blockedTruncated: true } : {}),
      relations,
    },
    {
      maxPinnedWorks: MAX_PINNED_WORKS,
      maxTrackedTasks: MAX_TRACKED_TASKS,
      maxBlockedPinned: MAX_BLOCKED_PINNED,
      maxArchivedTaskIndex: MAX_ARCHIVED_TASK_INDEX,
      maxOrphanCounters: MAX_WORK_COUNTERS,
      maxPendingProposals: MAX_PENDING_PROPOSALS,
      maxDecisions: MAX_ACTIVE_DECISIONS,
      maxEntries: MAX_STORED_ENTRIES,
      maxRelations: MAX_TRACKED_RELATIONS,
    },
  );
}

export function compactDossierState(
  state: DossierLedgerState,
  limits: {
    readonly maxPinnedWorks: number;
    readonly maxTrackedTasks: number;
    readonly maxBlockedPinned?: number;
    readonly maxArchivedTaskIndex?: number;
    readonly maxOrphanCounters: number;
    readonly maxPendingProposals?: number;
    readonly maxDecisions: number;
    readonly maxEntries: number;
    readonly maxRelations: number;
  },
): DossierLedgerState {
  const mutableTasks: Record<string, DossierTaskRecord> = { ...state.tasks };
  const mutableCounters: Record<string, DossierWorkCounter> = { ...state.workCounters };
  const maxArchivedIndex = limits.maxArchivedTaskIndex ?? MAX_ARCHIVED_TASK_INDEX;
  const prunedTasks = pruneTasks(
    mutableTasks,
    mutableCounters,
    limits.maxPinnedWorks,
    limits.maxTrackedTasks,
    limits.maxBlockedPinned ?? MAX_BLOCKED_PINNED,
    maxArchivedIndex,
  );
  const prunedCounters = pruneWorkCounters(
    mutableCounters,
    prunedTasks.tasks,
    Boolean(state.workCountersTruncated),
    limits.maxOrphanCounters,
    maxArchivedIndex,
  );
  const blockedTruncated = Boolean(
    state.blockedTruncated || prunedTasks.blockedEvicted || prunedCounters.blockedDropped,
  );
  const next: DossierLedgerState = {
    ...state,
    entries: state.entries.slice(0, limits.maxEntries),
    pendingProposals: pruneByRevision({ ...state.pendingProposals }, limits.maxPendingProposals ?? limits.maxDecisions),
    activeDecisions: pruneByRevision({ ...state.activeDecisions }, limits.maxDecisions),
    retiredDecisions: state.retiredDecisions.slice(0, Math.min(MAX_RETIRED_DECISIONS, limits.maxDecisions)),
    tasks: prunedTasks.tasks,
    workCounters: prunedCounters.counters,
    ...(blockedTruncated ? { blockedTruncated: true } : {}),
    relations: state.relations.slice(0, limits.maxRelations),
  };
  return prunedCounters.truncated ? { ...next, workCountersTruncated: true } : next;
}
