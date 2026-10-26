import type { CanonicalEventStore, TaskProjection } from "@harness-anything/kernel";
import { declarationRevision } from "./agent-entities.ts";

/**
 * Agent declaration version reads.
 *
 * The ledger is already the version history: every `entity_upserted` event carries a
 * `declarationDocumentClaim.sha256`, and content objects are retained by digest, so a version is
 * addressed by its declaration revision and read back from the content object it names. Nothing
 * here writes, and nothing here needs a version table.
 *
 * Two rules from the design hold at every read below:
 *  - the revision exposed is the declaration revision (`currentVersion`, the last upsert), never
 *    the projection row's `workspaceRevision`, which advances on `agent_retired`;
 *  - history filters `type: "entity_upserted"`, because an unfiltered entity list also returns
 *    `agent_retired`, which is a lifecycle fact rather than a version.
 */
export interface AgentVersionPorts {
  readonly projection: Pick<TaskProjection, "getEntity" | "readEventList" | "readOperation">;
  readonly store: Pick<CanonicalEventStore, "readContentBlob">;
}

/** The progress-diff bound shared with the task delivery diff reader: 2,000 lines / 2 MiB. */
export const MAX_AGENT_DIFF_LINES = 2_000;
export const MAX_AGENT_DIFF_BYTES = 2 * 1024 * 1024;
/** Above this many line pairs the LCS table is replaced by a whole-block replace. */
const LCS_CELL_BUDGET = 250_000;
export const DEFAULT_AGENT_HISTORY_LIMIT = 50;
export const MAX_AGENT_HISTORY_LIMIT = 500;

export interface AgentHistoryActor {
  readonly personId: string;
  readonly executorId: string | null;
}
export interface AgentHistoryVersion {
  readonly revision: number;
  readonly opId: string;
  readonly sha256: string;
  readonly size: number;
  readonly occurredAt: string;
  readonly actor: AgentHistoryActor;
  /** The zero-based position from the newest version: 0 is the current declaration. */
  readonly current: boolean;
  /** `instructions 4,211 B · 3 skills · 2 runtimes`, or null when summaries were not requested. */
  readonly summary: string | null;
}
export interface AgentHistoryRead {
  readonly schema: "agent-history/v1";
  readonly ok: true;
  readonly agentId: string;
  /** The declaration revision the install/delete fences compare against. */
  readonly revision: number;
  readonly versions: readonly AgentHistoryVersion[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}
export interface AgentVersionIdentity {
  readonly revision: number;
  readonly sha256: string;
}
export interface AgentVersionRead {
  readonly schema: "agent-version/v1";
  readonly ok: true;
  readonly agentId: string;
  readonly version: AgentHistoryVersion;
  /** The live declaration revision and body digest; equal to `version` when this is the current one. */
  readonly current: AgentVersionIdentity;
  /** The stored declaration bytes, parsed. Historical shapes the current schema no longer accepts
   *  are returned as-is instead of being re-judged here: the write boundary validated them when
   *  they were published, and a read must not turn an old declaration into a rejection. */
  readonly declaration: Readonly<Record<string, unknown>>;
  readonly fields: readonly AgentDiffField[];
  readonly truncated: boolean;
}
export interface AgentDiffRead {
  readonly schema: "agent-diff/v1";
  readonly ok: true;
  readonly agentId: string;
  readonly from: AgentVersionIdentity;
  readonly to: AgentVersionIdentity;
  readonly fields: readonly AgentDiffField[];
  readonly truncated: boolean;
}
export type AgentDiffLine = {
  readonly kind: "context" | "add" | "remove";
  readonly oldLineNo?: number;
  readonly newLineNo?: number;
  readonly text: string;
};
export type AgentDiffField =
  | {
      readonly field: "instructions";
      readonly kind: "changed";
      readonly lines: readonly AgentDiffLine[];
    }
  | {
      readonly field: "skills" | "runtimes" | "prompts";
      readonly kind: "changed";
      readonly added: readonly unknown[];
      readonly removed: readonly unknown[];
    }
  | {
      readonly field: "name" | "role" | "preset" | "instance" | "permissionMode";
      readonly kind: "changed";
      readonly from: unknown;
      readonly to: unknown;
    };

function entityError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

/** The current declaration revision and digest, or a not-found the caller can act on. */
function currentIdentity(ports: AgentVersionPorts, agentId: string): AgentVersionIdentity {
  const row = ports.projection.getEntity("agent", agentId);
  if (row === null || row.freshness !== "current")
    throw entityError("agent_not_found", `${agentId} is not an installed agent.`);
  const revision = declarationRevision(row),
    page = ports.projection.readEventList({ entity: `agent/${agentId}`, type: "entity_upserted", limit: 1 }),
    head = page.rows[0];
  // The declaration revision names the newest upsert event; the projection row and the event list
  // are read at the same cut, so a missing head is a corrupt projection rather than a race.
  if (head === undefined || head.revision !== revision)
    throw entityError(
      "agent_version_unavailable",
      `Agent ${agentId} declares revision ${revision} but its upsert event is not readable at this cut.`,
    );
  return { revision, sha256: claimOf(ports, agentId, head.opId).sha256 };
}

function claimOf(
  ports: AgentVersionPorts,
  agentId: string,
  opId: string,
): { readonly sha256: string; readonly size: number } {
  // The projection's event index answers the same canonical event the ledger holds and stays
  // readable on a replica cut, where the edge store only exposes content blobs.
  const event = ports.projection.readOperation(opId)?.event,
    claim = (event?.payload as { readonly declarationDocumentClaim?: unknown } | undefined)
      ?.declarationDocumentClaim as { readonly sha256?: unknown; readonly size?: unknown } | undefined;
  if (typeof claim?.sha256 !== "string" || typeof claim.size !== "number")
    throw entityError(
      "agent_version_unavailable",
      `The declaration content claim for agent ${agentId} (op ${opId}) is missing from the ledger.`,
    );
  return { sha256: claim.sha256, size: claim.size };
}

function bodyOf(ports: AgentVersionPorts, agentId: string, sha256: string): Readonly<Record<string, unknown>> {
  const bytes = ports.store.readContentBlob(sha256);
  if (bytes === null)
    throw entityError(
      "agent_version_unavailable",
      `The retained declaration body ${sha256} for agent ${agentId} is not readable.`,
    );
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new TypeError("declaration body must be one JSON object");
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw entityError(
      "agent_version_unavailable",
      `The retained declaration body ${sha256} for agent ${agentId} is not a JSON object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function byteLengthOf(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

function countLabel(count: number, singular: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : `${singular}s`}`;
}

/** The one-line version summary; the only history field that needs the declaration body. */
export function summarizeAgentDeclaration(declaration: Readonly<Record<string, unknown>>): string {
  const skills = Array.isArray(declaration.skills) ? declaration.skills.length : 0,
    runtimes = Array.isArray(declaration.runtimes) ? declaration.runtimes.length : 0,
    instructions = byteLengthOf(declaration.instructions);
  return `instructions ${instructions.toLocaleString("en-US")} B · ${countLabel(skills, "skill")} · ${countLabel(
    runtimes,
    "runtime",
  )}`;
}

export function readAgentHistory(
  ports: AgentVersionPorts,
  input: {
    readonly agentId: string;
    readonly limit?: number;
    readonly cursor?: string;
    /** Skip every content read: only the claim digest and size are returned. */
    readonly summaries?: boolean;
  },
): AgentHistoryRead {
  const limit = input.limit ?? DEFAULT_AGENT_HISTORY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AGENT_HISTORY_LIMIT)
    throw entityError(
      "invalid_command",
      `Agent history limit must be an integer between 1 and ${MAX_AGENT_HISTORY_LIMIT}.`,
    );
  let revisionBound: number | undefined;
  if (input.cursor !== undefined) {
    if (!/^[0-9]+$/u.test(input.cursor))
      throw entityError(
        "invalid_command",
        "Agent history cursor must be a revision boundary returned as nextCursor by an earlier page.",
      );
    revisionBound = Number(input.cursor);
  }
  const current = currentIdentity(ports, input.agentId),
    page = ports.projection.readEventList({
      entity: `agent/${input.agentId}`,
      type: "entity_upserted",
      limit,
      ...(revisionBound === undefined ? {} : { revisionBound }),
    }),
    versions = page.rows.map((row): AgentHistoryVersion => {
      const claim = claimOf(ports, input.agentId, row.opId);
      return {
        revision: row.revision,
        opId: row.opId,
        sha256: claim.sha256,
        size: claim.size,
        occurredAt: row.occurredAt,
        actor: { personId: row.actor.personId, executorId: row.actor.executorId },
        current: row.revision === current.revision,
        summary:
          input.summaries === false ? null : summarizeAgentDeclaration(bodyOf(ports, input.agentId, claim.sha256)),
      };
    });
  return {
    schema: "agent-history/v1",
    ok: true,
    agentId: input.agentId,
    revision: current.revision,
    versions,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

/** One declaration revision addressed by its upsert revision, with its difference to the live one. */
export function readAgentVersion(
  ports: AgentVersionPorts,
  input: { readonly agentId: string; readonly revision: number },
): AgentVersionRead {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    throw entityError("invalid_command", "Agent version revision must be a positive integer.");
  const current = currentIdentity(ports, input.agentId),
    // The exclusive upper bound returns the newest upsert at or below the requested revision; an
    // exact match means the requested revision is a declaration version of this agent, and any
    // other answer (a retried revision, a retire event, a foreign entity) is a missing version.
    page = ports.projection.readEventList({
      entity: `agent/${input.agentId}`,
      type: "entity_upserted",
      limit: 1,
      revisionBound: input.revision + 1,
    }),
    row = page.rows[0];
  if (row === undefined || row.revision !== input.revision)
    throw entityError(
      "agent_version_not_found",
      `Agent ${input.agentId} has no declaration version at revision ${input.revision}.`,
    );
  const claim = claimOf(ports, input.agentId, row.opId),
    declaration = bodyOf(ports, input.agentId, claim.sha256),
    live = bodyOf(ports, input.agentId, current.sha256),
    diff = diffAgentDeclarations(declaration, live);
  return {
    schema: "agent-version/v1",
    ok: true,
    agentId: input.agentId,
    version: {
      revision: row.revision,
      opId: row.opId,
      sha256: claim.sha256,
      size: claim.size,
      occurredAt: row.occurredAt,
      actor: { personId: row.actor.personId, executorId: row.actor.executorId },
      current: row.revision === current.revision,
      summary: summarizeAgentDeclaration(declaration),
    },
    current,
    declaration,
    fields: diff.fields,
    truncated: diff.truncated,
  };
}

/** The difference between two declaration revisions, newest second (the `--to` side). */
export function readAgentDiff(
  ports: AgentVersionPorts,
  input: { readonly agentId: string; readonly from: number; readonly to: number },
): AgentDiffRead {
  const from = resolveVersion(ports, input.agentId, input.from),
    to = resolveVersion(ports, input.agentId, input.to),
    body = (version: ResolvedAgentVersion) => bodyOf(ports, input.agentId, version.sha256),
    diff = diffAgentDeclarations(body(from), body(to));
  return {
    schema: "agent-diff/v1",
    ok: true,
    agentId: input.agentId,
    from: { revision: from.revision, sha256: from.sha256 },
    to: { revision: to.revision, sha256: to.sha256 },
    fields: diff.fields,
    truncated: diff.truncated,
  };
}

interface ResolvedAgentVersion {
  readonly revision: number;
  readonly opId: string;
  readonly sha256: string;
}

function resolveVersion(ports: AgentVersionPorts, agentId: string, revision: number): ResolvedAgentVersion {
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw entityError("invalid_command", "Agent version revision must be a positive integer.");
  // An existence check keeps a missing agent and a missing version distinct for the caller.
  currentIdentity(ports, agentId);
  const page = ports.projection.readEventList({
      entity: `agent/${agentId}`,
      type: "entity_upserted",
      limit: 1,
      revisionBound: revision + 1,
    }),
    row = page.rows[0];
  if (row === undefined || row.revision !== revision)
    throw entityError(
      "agent_version_not_found",
      `Agent ${agentId} has no declaration version at revision ${revision}.`,
    );
  return { revision: row.revision, opId: row.opId, sha256: claimOf(ports, agentId, row.opId).sha256 };
}

/** Fields compared by value rather than by body: a change here is a scalar replacement. */
const scalarDiffFields = ["name", "role", "preset", "instance", "permissionMode"] as const;
/** Fields compared as sets of whole entries. */
const setDiffFields = ["skills", "runtimes", "prompts"] as const;

export function diffAgentDeclarations(
  from: Readonly<Record<string, unknown>>,
  to: Readonly<Record<string, unknown>>,
): { readonly fields: readonly AgentDiffField[]; readonly truncated: boolean } {
  const fields: AgentDiffField[] = [];
  let truncated = false;
  const fromInstructions = typeof from.instructions === "string" ? from.instructions : "",
    toInstructions = typeof to.instructions === "string" ? to.instructions : "";
  if (fromInstructions !== toInstructions) {
    const lines = diffInstructionLines(fromInstructions, toInstructions);
    fields.push({ field: "instructions", kind: "changed", lines: lines.lines });
    truncated ||= lines.truncated;
  }
  for (const field of setDiffFields) {
    const before = entriesOf(from[field]),
      after = entriesOf(to[field]),
      beforeKeys = new Map(before.map((entry) => [JSON.stringify(entry), entry])),
      afterKeys = new Map(after.map((entry) => [JSON.stringify(entry), entry])),
      added = [...afterKeys].filter(([key]) => !beforeKeys.has(key)).map(([, entry]) => entry),
      removed = [...beforeKeys].filter(([key]) => !afterKeys.has(key)).map(([, entry]) => entry);
    if (added.length || removed.length) fields.push({ field, kind: "changed", added, removed });
  }
  for (const field of scalarDiffFields) {
    const before = from[field] ?? null,
      after = to[field] ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after))
      fields.push({ field, kind: "changed", from: before, to: after });
  }
  return { fields, truncated };
}

function entriesOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A line diff over the instructions facet. Equal-size small inputs use an LCS table; a large pair
 * falls back to a whole-block replace so an unbounded table can never be the read's cost. The
 * fallback is a complete diff of the same two texts, only coarser.
 */
export function diffInstructionLines(
  from: string,
  to: string,
): { readonly lines: readonly AgentDiffLine[]; readonly truncated: boolean } {
  const before = from === "" ? [] : from.split("\n"),
    after = to === "" ? [] : to.split("\n"),
    pairs = before.length * after.length;
  const lines: AgentDiffLine[] = [];
  let truncated = false;
  const emit = (line: AgentDiffLine) => {
    if (lines.length >= MAX_AGENT_DIFF_LINES) {
      truncated = true;
      return;
    }
    lines.push(line);
  };
  if (pairs > LCS_CELL_BUDGET) {
    before.forEach((text, index) => emit({ kind: "remove", oldLineNo: index + 1, text }));
    after.forEach((text, index) => emit({ kind: "add", newLineNo: index + 1, text }));
    return { lines, truncated };
  }
  // LCS lengths, computed bottom-up so reconstruction walks forward.
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1)
    for (let j = after.length - 1; j >= 0; j -= 1)
      table[i]![j] =
        before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  let i = 0,
    j = 0,
    emittedBytes = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      emittedBytes += byteLengthOf(before[i]);
      emit({ kind: "context", oldLineNo: i + 1, newLineNo: j + 1, text: before[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      emittedBytes += byteLengthOf(before[i]);
      emit({ kind: "remove", oldLineNo: i + 1, text: before[i]! });
      i += 1;
    } else {
      emittedBytes += byteLengthOf(after[j]);
      emit({ kind: "add", newLineNo: j + 1, text: after[j]! });
      j += 1;
    }
    if (emittedBytes > MAX_AGENT_DIFF_BYTES && !truncated) truncated = true;
    if (truncated) break;
  }
  for (; i < before.length && !truncated; i += 1) emit({ kind: "remove", oldLineNo: i + 1, text: before[i]! });
  for (; j < after.length && !truncated; j += 1) emit({ kind: "add", newLineNo: j + 1, text: after[j]! });
  return { lines, truncated };
}
