import { actionForCommand } from "./command-input-descriptors.ts";
import { commandSpecMap, commandSpecs, type CommandKind } from "./command-spec/index.ts";
import type {
  CommandDescriptorIdentity,
  CommandReceiptContract,
  CommandSuccessNext
} from "./command-spec/types.ts";

export type { CommandReceiptContract } from "./command-spec/types.ts";
export type { CommandKind } from "./command-spec/index.ts";

type ReceiptAnchorDescriptor = CommandDescriptorIdentity & {
  readonly receiptContract: CommandReceiptContract;
};

type SuccessNextDescriptor = CommandDescriptorIdentity & {
  readonly receiptContract: {
    readonly successNext?: CommandSuccessNext;
    readonly dryRun?: { readonly successNext?: CommandSuccessNext };
  };
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

export function assertCommandSuccessNextContracts(
  descriptors: ReadonlyArray<SuccessNextDescriptor> = commandSpecs
): void {
  const violations = descriptors.flatMap((descriptor) => {
    const declarations = [
      { variant: "success", declaration: descriptor.receiptContract.successNext },
      ...(descriptor.receiptContract.dryRun
        ? [{ variant: "dry-run success", declaration: descriptor.receiptContract.dryRun.successNext }]
        : [])
    ];
    return declarations.flatMap(({ variant, declaration }) => validateSuccessNextDeclaration(descriptor, variant, declaration));
  });
  if (violations.length > 0) {
    throw new Error(`Command success next-step contract violations:\n${violations.join("\n")}`);
  }
}

function validateSuccessNextDeclaration(
  descriptor: CommandDescriptorIdentity,
  variant: string,
  declaration: CommandSuccessNext | undefined
): ReadonlyArray<string> {
  const label = `${descriptor.kind} (${descriptor.usage}) ${variant}`;
  if (!declaration) return [`${label} must explicitly declare successNext`];
  if (declaration.kind === "none") return [];
  if (declaration.actions.length === 0) return [`${label} actions must be non-empty; use { kind: "none" } instead`];
  return declaration.actions.flatMap((action, index) => [
    ...(action.command.trim().length === 0 ? [`${label} action ${index + 1} must declare a command`] : []),
    ...(action.description.trim().length === 0 ? [`${label} action ${index + 1} must declare distilled guidance`] : [])
  ]);
}

const canonicalContracts = commandSpecMap((entry) => entry.receiptContract);
const decisionTransitionContract = {
  data: ["decisionId", "decisionState", "report"],
  paths: ["primary"],
  successNext: { kind: "none" }
} satisfies CommandReceiptContract;

export const commandReceiptContractsByKind: Record<string, CommandReceiptContract> = {
  ...canonicalContracts,
  "task-trace": { data: ["taskId", "report"], paths: [], successNext: { kind: "none" } },
  "task-tree": { data: ["taskId", "tasks", "report"], paths: [], successNext: { kind: "none" } },
  "session-trace": { data: ["sessionId", "report"], paths: [], successNext: { kind: "none" } },
  "decision-accept": decisionTransitionContract,
  "decision-reject": decisionTransitionContract,
  "decision-defer": decisionTransitionContract,
  "decision-supersede": decisionTransitionContract,
  "decision-retire": decisionTransitionContract,
  "doc-sync-dry-run": { data: ["rows", "report"], paths: ["primary"], successNext: { kind: "none" } },
  "doc-sync-submit": { data: ["report"], paths: [], successNext: { kind: "none" } },
  "snapshot-multica": { data: ["report"], paths: [], successNext: { kind: "none" } },
  "snapshot-github": { data: ["report"], paths: [], successNext: { kind: "none" } },
  "list-github": { data: ["rows", "report"], paths: [], successNext: { kind: "none" } },
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
    paths: [],
    successNext: { kind: "none" }
  }
};

export const commandDryRunPreviewRequiredByKind: Record<CommandKind, boolean> = {
  ...commandSpecMap((entry) => entry.options.some((option) => option.flag === "--dry-run"))
};
