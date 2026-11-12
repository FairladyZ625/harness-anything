import {
  docCandidateStates,
  projectedDocumentSyncStates,
  observedDocumentSyncStates,
} from "./authored-document-status.ts";
import type { StatusVocabulary, StatusWordRegistration } from "./status-vocabulary.ts";

/**
 * Authored-document candidate and replica status words owned by the kernel domain
 * (dec_6B912A63D279A922FA1288536D CH2). The status-vocabulary gate scans daemon,
 * application, and CLI sources for authored-document vocabularies and refuses any
 * that is not registered here first. Candidate disposition and replica sync state
 * are separate axes; neither is the document's content readiness.
 */
export const authoredDocumentStatusVocabularies: readonly StatusVocabulary[] = [
  {
    id: "docCandidate.state",
    entity: "AuthoredDocument",
    field: "candidate state",
    module: "packages/kernel/src/domain/authored-document-status.ts",
    anchor: "docCandidateStates",
    words: docCandidateStates,
    note: "One scan's verdict on a local candidate row; never a persisted document state.",
  },
  {
    id: "documentReplica.syncState",
    entity: "AuthoredDocument",
    field: "syncState",
    module: "packages/kernel/src/domain/authored-document-status.ts",
    anchor: "projectedDocumentSyncStates",
    words: projectedDocumentSyncStates,
    note: "Replica visibility of a read cut against the accepted canonical cut; not content readiness.",
  },
  {
    id: "documentReplica.syncState-observed",
    entity: "AuthoredDocument",
    field: "syncState",
    module: "packages/kernel/src/domain/authored-document-status.ts",
    anchor: "observedDocumentSyncStates",
    words: observedDocumentSyncStates,
    subsetOf: "documentReplica.syncState",
  },
  {
    id: "wire.document-sync-state",
    entity: "DaemonWire",
    field: "syncState",
    module: "packages/daemon/src/protocol/daemon-protocol-gui-types.ts",
    anchor: "#syncState",
    words: ["synced", "unsynced", "unobservable", "derived"],
    mirrorOf: "documentReplica.syncState",
  },
];

const candidate = (word: string, meaning: string, resolution?: string): StatusWordRegistration =>
  resolution === undefined
    ? { word, entity: "AuthoredDocument", field: "candidate state", meaning, divergence: "entity-scoped" }
    : { word, entity: "AuthoredDocument", field: "candidate state", meaning, divergence: "divergent", resolution };
const sync = (word: string, meaning: string): StatusWordRegistration => ({
  word,
  entity: "AuthoredDocument",
  field: "syncState",
  meaning,
  divergence: "entity-scoped",
});

export const authoredDocumentStatusWordRegister: readonly StatusWordRegistration[] = [
  candidate("clean", "The local copy matches the canonical cut; nothing to submit."),
  candidate("eligible", "The local change can be submitted as a candidate write."),
  candidate("inapplicable", "The local change is outside any path this submit may write."),
  candidate(
    "blocked",
    "The scanner refused the candidate row and names a rejection code and next action.",
    "Task.blocked is a dependency wait; this is a per-scan refusal. The AuthoredDocument domain slice decides the rename.",
  ),
  candidate("deletion", "The local copy removed a canonical document; submitting retires it."),
  candidate(
    "conflict",
    "The local change and a newer canonical cut both changed the same path.",
    "Write-chain conflicts are commit races; this is a stale-base candidate. The AuthoredDocument domain slice decides the rename.",
  ),
  sync("synced", "The read cut matches the accepted canonical cut."),
  sync("unsynced", "The read cut differs from the accepted canonical cut."),
  sync("unobservable", "The requested cut could not be observed; absence of evidence, not a difference."),
  sync("derived", "The document is a rendered derivative with no canonical cut to compare."),
];
