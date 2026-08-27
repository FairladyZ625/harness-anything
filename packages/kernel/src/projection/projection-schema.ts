// Version 12 combines the rebuildable squad-run projection added in version 11
// with UTC ISO-8601 Z materialized timestamps. Immutable event bytes retain their
// historical offset spelling. A version mismatch takes the discard-and-replay
// path in rebuildable-task-projection.ts; squad-coordinator then sees its durable
// ready marker cleared and replays dispatch streams into the local-only table.
export const taskProjectionSchemaVersion = 12;
