import {
  makeJournaledWriteCoordinator,
  taskCompletionEvidenceDeclaration,
  type TaskCompletionEvidence
} from "../../src/index.ts";
import {
  sha256Text,
  stablePayloadHash,
  writeDeclaredEntityTransaction
} from "../../../kernel/src/index.ts";
import { runEffect } from "../effect-test-helpers.ts";
import { writeAttribution } from "../test-attribution.ts";
import { taskIndex } from "../execution-saga-fixtures.ts";

const [rootDir, taskId] = process.argv.slice(2);
if (!rootDir || !taskId) throw new Error("completion evidence transaction worker requires rootDir and taskId");

const currentIndex = taskIndex(taskId, "active");
const completedIndex = currentIndex.replace(/^(  status:\s*).+$/mu, "$1done");
const evidence: TaskCompletionEvidence = {
  schema: "task-completion-evidence/v1",
  taskId,
  mode: "commit-anchor",
  anchor: {
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repository: "workspace",
    codeDocRecordIds: ["cdr_completion_atomicity"],
    codeDocDocumentSha256: `sha256:${"b".repeat(64)}`
  },
  judgment: {
    actor: {
      principal: { kind: "person", personId: "alice" },
      executor: { kind: "agent", id: "codex" }
    },
    sessionRef: "session/completion-atomicity",
    rationale: "The workspace commit implements and verifies the task.",
    judgedAt: "2026-07-18T09:00:00.000Z"
  },
  gateReceipt: {
    applicableGates: ["check:local"],
    ci: "passed",
    closeout: "passed",
    codeDoc: "passed"
  }
};

await runEffect(writeDeclaredEntityTransaction(
  makeJournaledWriteCoordinator({
    rootDir,
    attribution: writeAttribution("alice", "codex")
  }),
  stablePayloadHash,
  taskCompletionEvidenceDeclaration,
  { taskId },
  evidence,
  [{ taskId, path: "INDEX.md", body: completedIndex }],
  [{ taskId, path: "INDEX.md", bodySha256: sha256Text(currentIndex) }]
));
