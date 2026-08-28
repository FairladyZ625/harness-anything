// Version 13 forces upgraded nodes to discard version-12 warm caches before
// replaying fact-rekey ledger rewrites that preserve opId and workspaceRevision.
// A version mismatch takes the discard-and-replay path; squad-coordinator then
// sees its durable ready marker cleared and replays dispatch streams locally.
export const taskProjectionSchemaVersion = 13;
