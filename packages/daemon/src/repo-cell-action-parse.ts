import {
  decisionProposalJsonFields,
  decisionProposalRequiredJsonFields,
  taskCreateJsonFields,
} from "../../preset/src/index.ts";
import { consumeKnownError, type SettingsV1 } from "../../kernel/src/index.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { packetRecord, readPacketSource, workspaceText } from "./repo-cell-packets.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

export const decisionProposalFields = decisionProposalJsonFields;

export const taskCreateFields = taskCreateJsonFields;

export type PacketActionContract = Readonly<{
  required: readonly string[];
  allowed: readonly string[];
  actionOverrides?: readonly string[];
  invalid: (message: string) => Error;
  messages: Readonly<{
    parse: string;
    object: string;
    unsupportedAction: (fields: string[]) => string;
    unsupportedInput: (fields: string[]) => string;
    missingInput?: (fields: string[]) => string;
  }>;
  validate?: (packet: Record<string, unknown>) => void;
  merge?: (action: RepoTaskAction, packet: Record<string, unknown>) => RepoTaskAction;
}>;

export function resolvePacketAction(
  rootDir: string,
  action: RepoTaskAction,
  contract: PacketActionContract,
): RepoTaskAction {
  const fromFile = typeof action.fromFile === "string",
    jsonInput = typeof action.jsonInput === "string",
    hasSource = fromFile || jsonInput,
    sourceFields = fromFile ? ["fromFile"] : jsonInput ? ["jsonInput"] : contract.allowed,
    actionAllowed = contract.actionOverrides
      ? new Set(["kind", ...sourceFields, ...contract.actionOverrides])
      : undefined,
    unsupportedActionFields = actionAllowed ? Object.keys(action).filter((field) => !actionAllowed.has(field)) : [];
  if (unsupportedActionFields.length)
    throw contract.invalid(contract.messages.unsupportedAction(unsupportedActionFields));
  if (!hasSource) return action;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readPacketSource(rootDir, action));
  } catch (error) {
    if (error instanceof SyntaxError) throw contract.invalid(contract.messages.parse);
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw contract.invalid(contract.messages.object);
  const packet = parsed as Record<string, unknown>,
    unknown = Object.keys(packet).filter((field) => !contract.allowed.includes(field)),
    missing = contract.required.filter((field) => !Object.hasOwn(packet, field));
  if (unknown.length) throw contract.invalid(contract.messages.unsupportedInput(unknown));
  if (missing.length && contract.messages.missingInput) throw contract.invalid(contract.messages.missingInput(missing));
  contract.validate?.(packet);
  return contract.merge ? contract.merge(action, packet) : { kind: action.kind, ...packet };
}

export function taskCreateAction(rootDir: string, action: RepoTaskAction): RepoTaskAction {
  const fromFile = typeof action.fromFile === "string",
    jsonInput = typeof action.jsonInput === "string";
  const unsupported = Object.keys(action).filter(
    (field) => !["kind", "fromFile", "jsonInput", "dryRun", ...taskCreateFields].includes(field),
  );
  if (unsupported.length)
    throw cellCodedError("invalid_command", `Remove unsupported task create fields: ${unsupported.join(", ")}.`);
  if (!fromFile && !jsonInput) return action;
  if (fromFile === jsonInput)
    throw cellCodedError("invalid_command", "Choose exactly one structured task source: --from-file or --json-input.");
  return resolvePacketAction(rootDir, action, {
    required: [],
    allowed: taskCreateFields,
    invalid: (message) => cellCodedError("invalid_command", message),
    messages: {
      parse: "Task create input must be one UTF-8 JSON object; repair the JSON and retry.",
      object: "Task create input must be one JSON object.",
      unsupportedAction: (fields) => `Remove unsupported task create fields: ${fields.join(", ")}.`,
      unsupportedInput: (fields) => `Remove unsupported task create fields: ${fields.join(", ")}.`,
    },
    merge: (source, packet) => {
      const { fromFile: _fromFile, jsonInput: _jsonInput, kind: _kind, ...direct } = source;
      return { kind: "task-create", ...packet, ...direct };
    },
  });
}

export function decisionProposalAction(
  rootDir: string,
  action: RepoTaskAction,
  settings: () => SettingsV1,
): RepoTaskAction {
  if (action.kind === "decision-amend") {
    if (typeof action.body === "string" && typeof action.bodyFile === "string")
      throw cellCodedError("invalid_command", "Use only one of --body or --body-file.");
    if (typeof action.bodyFile !== "string") return action;
    const { bodyFile: _bodyFile, ...rest } = action;
    return {
      ...rest,
      body: workspaceText(rootDir, action.bodyFile, "bodyFile"),
    };
  }
  if (action.kind !== "decision-propose") {
    if (Object.hasOwn(action, "bodyFile") || Object.hasOwn(action, "body"))
      throw cellCodedError(
        "invalid_command",
        "Only decision amend and relation replace may change existing Decision prose.",
      );
    return action;
  }
  const allowed = ["kind", "fromFile", "jsonInput", "body", "bodyFile"],
    fromFile = typeof action.fromFile === "string",
    jsonInput = typeof action.jsonInput === "string",
    direct = !fromFile && !jsonInput;
  if (
    direct &&
    Object.keys(action).sort().join("\0") === ["kind", ...decisionProposalFields, "body"].sort().join("\0") &&
    typeof action.body === "string"
  )
    return action;
  if (
    Object.keys(action).some((field) => !allowed.includes(field)) ||
    fromFile === jsonInput ||
    (action.body !== undefined && typeof action.body !== "string") ||
    (action.bodyFile !== undefined && typeof action.bodyFile !== "string") ||
    (typeof action.body === "string" && typeof action.bodyFile === "string")
  )
    throw cellCodedError(
      "invalid_command",
      "Decision propose requires one structured packet and at most one body source.",
    );
  const source = readPacketSource(rootDir, action),
    parsed = tryParseJsonObject(source),
    defaults = {
      ...(parsed && !Object.hasOwn(parsed, "vertical") ? { vertical: settings().defaultVertical } : {}),
      preset: "decision-conformance",
      appliesTo: { modules: [], productLines: [] },
      fulfillments: [],
    },
    packet = packetRecord(
      rootDir,
      { ...action, jsonInput: source, fromFile: undefined },
      decisionProposalRequiredJsonFields,
      "decision proposal",
      defaults,
      decisionProposalFields,
    ),
    body =
      typeof action.body === "string"
        ? action.body
        : typeof action.bodyFile === "string"
          ? workspaceText(rootDir, action.bodyFile, "bodyFile")
          : undefined;
  return {
    kind: "decision-propose",
    ...packet.value,
    ...(body === undefined ? {} : { body }),
    defaultedDecisionPacketFields: [...packet.defaultedFields, "relations"],
  };
}

function tryParseJsonObject(source: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
