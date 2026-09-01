import path from "node:path";
import {
  consumeKnownError,
  isFactEvent,
  ledgerGitPath,
  localGitObjectRefStore,
  parseCanonicalEvent,
  resolveLedgerGitLayout,
  validateFactEvent,
  type CanonicalEventStore,
  type FactEventV1,
  type PersistedCanonicalEventV1,
} from "../../kernel/src/index.ts";
import {
  restateLegacyMigrationTaskProvenance,
  type MigrationEventRead,
  type MigrationTaskProvenanceRestatement,
} from "./migration-task-provenance-restatement.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";

export function readFactRekeyEvents(rootDir: string, store: CanonicalEventStore): MigrationEventRead {
  const ledger = resolveLedgerGitLayout(rootDir),
    commit = store.currentCommit().sha,
    prefix = ledgerGitPath(ledger, "events/");
  const entries = localGitObjectRefStore
    .listTree(ledger.rootDir, commit, ledger.authoredPrefix || undefined)
    .filter(({ target }) => target.startsWith(prefix) && !target.endsWith("/head.json") && target.endsWith(".json"));
  if (entries.length === 0) return { events: [], migrationTaskProvenanceRestatements: [] };
  const output = localGitObjectRefStore.batch(ledger.rootDir, `${entries.map(({ oid }) => oid).join("\n")}\n`),
    events: PersistedCanonicalEventV1[] = [],
    migrationTaskProvenanceRestatements: MigrationTaskProvenanceRestatement[] = [];
  let cursor = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(10, cursor);
    if (headerEnd < 0) break;
    const size = Number(output.subarray(cursor, headerEnd).toString("utf8").split(" ").at(-1)),
      start = headerEnd + 1,
      body = output.subarray(start, start + size).toString("utf8");
    cursor = start + size + 1;
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch (error) {
      consumeKnownError(error);
      events.push(parseCanonicalEvent(body));
      continue;
    }
    try {
      events.push(normalizeLegacyFactEvent(value) ?? parseCanonicalEvent(body));
    } catch (error) {
      const sourcePath = entry.target.split(path.sep).join("/"),
        restated = restateLegacyMigrationTaskProvenance(value, body);
      if (restated === null) throw error;
      consumeKnownError(error);
      events.push(restated);
      migrationTaskProvenanceRestatements.push({ opId: restated.opId, sourcePath });
    }
  }
  return {
    events: events.sort((left, right) => left.workspaceRevision - right.workspaceRevision),
    migrationTaskProvenanceRestatements: migrationTaskProvenanceRestatements.sort(
      (left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.opId.localeCompare(right.opId),
    ),
  };
}

function normalizeLegacyFactEvent(value: unknown): FactEventV1 | null {
  if (!isJsonObject(value) || value.schema !== "fact-event/v1" || !isJsonObject(value.payload)) return null;
  const payload = value.payload;
  if (!Array.isArray(payload.provenance) || !isJsonObject(payload.factsDocumentClaim)) return null;
  const provenance = payload.provenance.map((entry) => {
    if (
      !isJsonObject(entry) ||
      typeof entry.runtime !== "string" ||
      (typeof entry.sessionId !== "string" && entry.sessionId !== null) ||
      typeof entry.boundAt !== "string"
    )
      return null;
    return {
      ...entry,
      runtime: entry.runtime,
      sessionId: entry.sessionId,
      boundAt: entry.boundAt,
      transcriptReachability:
        entry.transcriptReachability === "dispatch_stream_only" || entry.transcriptReachability === "unavailable"
          ? entry.transcriptReachability
          : ("by_session_id" as const),
    };
  });
  if (provenance.some((entry) => entry === null) || typeof value.factId !== "string") return null;
  const normalized = { ...value, schema: "fact-event/v1" as const, payload: { ...payload, provenance } };
  const legacySupersedes = isJsonObject(payload.supersedes) ? payload.supersedes : null,
    legacySupersededFactId =
      typeof legacySupersedes?.factRef === "string"
        ? /^fact\/[^/]+\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(legacySupersedes.factRef)?.[1]
        : undefined;
  const validationCandidate = {
    ...normalized,
    payload: {
      ...normalized.payload,
      factsDocumentClaim: { ...payload.factsDocumentClaim, path: `facts/${value.factId}.md` },
      ...(legacySupersededFactId && legacySupersedes
        ? { supersedes: { ...legacySupersedes, factRef: `fact/${legacySupersededFactId}` } }
        : {}),
    },
  };
  if (validateFactEvent(validationCandidate).length > 0 || !isFactEvent(normalized)) return null;
  return normalized;
}
