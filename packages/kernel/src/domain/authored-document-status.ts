// Candidate disposition and replica visibility are separate from authored-document content readiness.
// dec_499E4E98A3D4754132B3BCA1E6: move daemon-owned words into the document domain.
export const docCandidateStates = ["clean", "eligible", "inapplicable", "blocked", "deletion", "conflict"] as const;
export type DocCandidateState = (typeof docCandidateStates)[number];
export const projectedDocumentSyncStates = ["synced", "unsynced", "unobservable", "derived"] as const;
export type ProjectedDocumentSyncState = (typeof projectedDocumentSyncStates)[number];
export const observedDocumentSyncStates = ["synced", "unsynced", "unobservable"] as const;
export type ObservedDocumentSyncState = (typeof observedDocumentSyncStates)[number];
