import {
  makeCoordinatedExecutionAuthoredStore,
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore,
  taskHolderActor,
  type ExecutionRecord
} from "../../src/index.ts";
import { sha256Text } from "../../../kernel/src/index.ts";
import { writeAttribution } from "../test-attribution.ts";

const [rootDir, taskId, executionId] = process.argv.slice(2);
if (!rootDir || !taskId || !executionId) throw new Error("claim transaction worker requires rootDir, taskId, and executionId");

const execution: ExecutionRecord = {
  schema: "execution/v2",
  execution_id: executionId,
  task_ref: `task/${taskId}`,
  state: "active",
  primary_actor: taskHolderActor(
    { personId: "alice", displayName: "Alice" },
    { kind: "agent", id: "codex" }
  ),
  claimed_at: "2026-07-30T00:00:00.000Z",
  submitted_at: null,
  closed_at: null,
  session_bindings: [],
  outputs: [],
  submission: null
};

const plan = "# Plan\n\nImplement the atomic claim transaction.\n";
await makeCoordinatedExecutionAuthoredStore({
  rootInput: rootDir,
  coordinator: makeJournaledWriteCoordinator({
    rootDir,
    attribution: writeAttribution("alice", "codex")
  }),
  artifactStore: makeMarkdownArtifactStore({ rootDir })
}).openExecution({
  taskId,
  execution,
  activation: { taskPlanBodySha256: sha256Text(plan) }
});
