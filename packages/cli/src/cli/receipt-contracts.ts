import { actionForCommand } from "./command-input-descriptors.ts";
import { commandSpecMap, commandSpecs, type CommandKind } from "./command-spec/index.ts";
import type { CommandDescriptorIdentity, CommandReceiptContract } from "./command-spec/types.ts";

export type { CommandReceiptContract } from "./command-spec/types.ts";
export type { CommandKind } from "./command-spec/index.ts";

type ReceiptAnchorDescriptor = CommandDescriptorIdentity & {
  readonly receiptContract: CommandReceiptContract;
};

const pathAnchoredActions = new Set(["create", "propose", "record", "scaffold"]);

export function assertCommandReceiptAnchorContracts(
  descriptors: ReadonlyArray<ReceiptAnchorDescriptor> = commandSpecs
): void {
  const violations = descriptors.flatMap((descriptor) => {
    const action = actionForCommand(descriptor);
    if (action === "list" && !descriptor.receiptContract.data.includes("rows")) {
      return [`${descriptor.kind} (${descriptor.usage}) must declare data.rows`];
    }
    if (pathAnchoredActions.has(action) && descriptor.receiptContract.paths.length === 0) {
      return [`${descriptor.kind} (${descriptor.usage}) must declare a required path`];
    }
    return [];
  });
  if (violations.length > 0) {
    throw new Error(`Command receipt anchor contract violations:\n${violations.join("\n")}`);
  }
}

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
    data: ["taskId", "preset", "report"],
    optionalData: {
      evidenceBundle: "Only emitted when the action produced an evidence bundle.",
      generated: "Only emitted when the action executed and reported generated paths.",
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
