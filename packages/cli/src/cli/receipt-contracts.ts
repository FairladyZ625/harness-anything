import { commandSpecMap, type CommandKind } from "./command-spec/index.ts";
import type { CommandReceiptContract } from "./command-spec/types.ts";

export type { CommandReceiptContract } from "./command-spec/types.ts";
export type { CommandKind } from "./command-spec/index.ts";

const canonicalContracts = commandSpecMap((entry) => entry.receiptContract);
const decisionTransitionContract = { data: ["decisionId", "decisionState", "report"], paths: ["primary"] } satisfies CommandReceiptContract;

export const commandReceiptContractsByKind: Record<string, CommandReceiptContract> = {
  ...canonicalContracts,
  "task-trace": { data: ["taskId", "report"], paths: [] },
  "task-tree": { data: ["taskId", "tasks", "report"], paths: [] },
  "session-trace": { data: ["sessionId", "report"], paths: [] },
  "decision-accept": decisionTransitionContract,
  "decision-reject": decisionTransitionContract,
  "decision-defer": decisionTransitionContract,
  "decision-supersede": decisionTransitionContract,
  "decision-retire": decisionTransitionContract,
  "doc-sync-dry-run": { data: ["rows", "report"], paths: ["primary"] },
  "doc-sync-submit": { data: ["report"], paths: [] },
  "snapshot-multica": { data: ["report"], paths: [] },
  "snapshot-github": { data: ["report"], paths: [] },
  "list-github": { data: ["rows", "report"], paths: [] },
  "preset-run": canonicalContracts["preset-entrypoint"],
  "preset-action": {
    data: ["taskId", "preset", "evidenceBundle", "generated", "report"],
    optionalData: {
      rows: "Only emitted when a scripted preset action writes a numeric rows value in its result.",
      runId: "Only emitted by the semantic script host for an executable v3 entrypoint.",
      capabilityReceipt: "Only emitted by v3 semantic execution with its exact provider bindings."
    },
    paths: []
  }
};

export const commandDryRunPreviewRequiredByKind: Record<CommandKind, boolean> = {
  ...commandSpecMap((entry) => entry.options.some((option) => option.flag === "--dry-run"))
};
