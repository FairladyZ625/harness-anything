import {
  edgeReadModelEntries,
  serializeEventHead,
  serializePersistedCanonicalEvent,
  sha256Text,
  stableStringify,
  type ReplicaChange,
  type ReplicaProjectionBasis,
  type EdgeReadModelRows,
  type ReplicaRevision,
  type ReplicaSequenceRead,
} from "@harness-anything/kernel";
import { openReplicaCutSource as openSource, type ReplicaCutSourceOptions } from "../src/fleet/replica-cut-store.ts";

/** Synthetic read-model inputs for cut-store transport tests; real projection tests use its durable sequence. */
type FixtureOptions = Omit<ReplicaCutSourceOptions, "readSequence" | "readRevision"> & {
  readonly readBasis: (after: number | null) => ReplicaProjectionBasis;
  readonly withReadSnapshot?: <T>(read: () => T) => T;
  readonly readEdgeReadModel?: <T>(
    read: (model: { sourceRevision: number; rootThreshold: number; rows: EdgeReadModelRows } | null) => T,
  ) => T;
};
type State = { identity: ReplicaRevision; entries: Map<string, Extract<ReplicaChange, { op: "put" }>> };
const repositories = new Map<string, Map<number, State>>();
export function openReplicaCutSource(options: FixtureOptions) {
  const key = `${options.localRoot}/${options.repoId}`;
  const states = repositories.get(key) ?? new Map<number, State>();
  repositories.set(key, states);
  const captureAt = (after: number | null) => {
    const basis = options.readBasis(after),
      event = basis.headEvent;
    if (!event || basis.watermark !== basis.sourceRevision || !basis.watermark) return null;
    if (states.has(basis.watermark)) return states.get(basis.watermark)!;
    const entries = new Map<string, Extract<ReplicaChange, { op: "put" }>>();
    for (const row of basis.documents)
      entries.set(row.path, {
        op: "put",
        path: row.path,
        blob: { sha256: row.blobSha256, size: row.size, mediaType: row.mediaType },
        text: null,
      });
    options.readEdgeReadModel?.((model) => {
      if (!model) throw new Error("Read model is unavailable");
      for (const entry of edgeReadModelEntries(model))
        entries.set(entry.path, { op: "put", path: entry.path, blob: null, text: entry.text });
    });
    const identity = {
      revision: event.workspaceRevision,
      headDigest: `sha256:${sha256Text(serializeEventHead({ revision: event.workspaceRevision, opId: event.opId, eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}` }))}`,
      occurredAt: event.occurredAt,
    };
    const state = { identity, entries };
    states.set(identity.revision, state);
    return state;
  };
  const capture = (after: number | null) =>
    options.withReadSnapshot ? options.withReadSnapshot(() => captureAt(after)) : captureAt(after);
  return openSource({
    ...options,
    readRevision: (revision) => {
      const current = capture(states.size ? Math.max(...states.keys()) : null);
      return revision === undefined ? (current?.identity ?? null) : (states.get(revision)?.identity ?? null);
    },
    readSequence: (from): ReplicaSequenceRead | null => {
      const current = capture(from);
      if (!current) return null;
      const previous = from === null ? null : states.get(from);
      if (from !== null && !previous) return null;
      const changes: ReplicaChange[] = [];
      for (const entry of current.entries.values())
        if (stableStringify(previous?.entries.get(entry.path)) !== stableStringify(entry)) changes.push(entry);
      for (const itemPath of previous?.entries.keys() ?? [])
        if (!current.entries.has(itemPath)) changes.push({ op: "delete", path: itemPath });
      return { from: previous?.identity ?? null, to: current.identity, changes };
    },
  });
}
