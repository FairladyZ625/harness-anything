import assert from "node:assert/strict";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import { makeSqliteTaskEventStore } from "../../src/sqlite/index.ts";
import { localGitProcessCount } from "../../src/store/local-version-control-system.ts";
import { eventAt } from "./task-event-store.fixtures.ts";

const [rootDir, repoId] = process.argv.slice(2);
const store = makeSqliteTaskEventStore({ rootDir, repoId });
const event = eventAt(1),
  before = localGitProcessCount();
assert.equal(store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }).revision, 1);
assert.equal(localGitProcessCount(), before);
// Exit at durable acceptance without drain or an in-memory follower callback.
process.exit(0);
