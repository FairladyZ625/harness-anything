import { realpathSync } from "node:fs";
import path from "node:path";
import { decisionProposalJsonFields, taskCreateJsonFields } from "../../preset/src/index.ts";
import { cellCodedError, cellErrorCode } from "./repo-cell-errors.ts";
import { packetFile, packetJson, workspaceText } from "./repo-cell-packets.ts";
import { requiredCellText } from "./repo-cell-settlement.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

export const decisionProposalFields = decisionProposalJsonFields;

export const taskCreateFields = taskCreateJsonFields;

export type PacketActionContract = Readonly<{
  required: readonly string[];
  allowed: readonly string[];
  source: "from-file" | "from-file-or-json-input";
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
    hasSource = contract.source === "from-file" ? fromFile : fromFile || jsonInput,
    sourceFields =
      contract.source === "from-file"
        ? fromFile
          ? ["fromFile"]
          : contract.allowed
        : fromFile
          ? ["fromFile"]
          : jsonInput
            ? ["jsonInput"]
            : contract.allowed,
    actionAllowed = new Set(["kind", ...sourceFields, ...(contract.actionOverrides ?? [])]),
    unsupportedActionFields = Object.keys(action).filter((field) => !actionAllowed.has(field));
  if (unsupportedActionFields.length)
    throw contract.invalid(contract.messages.unsupportedAction(unsupportedActionFields));
  if (!hasSource) return action;
  let parsed: unknown;
  try {
    const raw = fromFile
      ? workspaceText(rootDir, action.fromFile, "fromFile")
      : requiredCellText(action.jsonInput, "jsonInput");
    parsed = JSON.parse(raw);
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
    jsonInput = typeof action.jsonInput === "string",
    fromLegacy = typeof action.fromLegacyId === "string";
  if (fromLegacy) {
    if (fromFile || jsonInput)
      throw cellCodedError(
        "invalid_command",
        "Use --from-legacy by itself, with only optional --title, --slug, or --dry-run overrides.",
      );
    const allowed = ["kind", "fromLegacyId", "title", "slug", "dryRun"],
      invalid = Object.keys(action).filter((field) => !allowed.includes(field));
    if (invalid.length)
      throw cellCodedError("invalid_command", `Remove ${invalid.join(", ")} from --from-legacy task creation.`);
    return legacyTaskCreateAction(rootDir, action);
  }
  if (!fromFile && !jsonInput) return action;
  if (fromFile === jsonInput)
    throw cellCodedError("invalid_command", "Choose exactly one structured task source: --from-file or --json-input.");
  const resolved = resolvePacketAction(rootDir, action, {
    required: [],
    allowed: taskCreateFields,
    source: "from-file-or-json-input",
    actionOverrides: ["title", "slug", "dryRun"],
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
  return typeof resolved.fromLegacyId === "string" ? taskCreateAction(rootDir, resolved) : resolved;
}

export function legacyTaskCreateAction(rootDir: string, action: RepoTaskAction): RepoTaskAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(workspaceText(rootDir, "harness/legacy/index.json", "legacy index"));
  } catch (error) {
    if (cellErrorCode(error) === "invalid_command")
      throw cellCodedError(
        "legacy_index_missing",
        "Create a valid harness/legacy/index.json with ha legacy index, then retry --from-legacy.",
      );
    throw error;
  }
  const entries =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).entries
        : null,
    legacyId = requiredCellText(action.fromLegacyId, "fromLegacyId"),
    entry = Array.isArray(entries)
      ? (entries.find(
          (value) => value && typeof value === "object" && (value as Record<string, unknown>).id === legacyId,
        ) as Record<string, unknown> | undefined)
      : undefined;
  if (!entry)
    throw cellCodedError(
      "legacy_entry_not_found",
      `Add legacy entry ${legacyId} to harness/legacy/index.json, then retry --from-legacy.`,
    );
  const storedPath = requiredCellText(entry.storedPath, "legacy storedPath");
  try {
    const root = realpathSync(rootDir),
      stored = realpathSync(path.resolve(root, storedPath));
    if (stored !== root && !stored.startsWith(`${root}${path.sep}`)) throw new Error("outside");
  } catch {
    throw cellCodedError(
      "legacy_source_missing",
      `Restore ${storedPath} inside the workspace, then retry --from-legacy ${legacyId}.`,
    );
  }
  return {
    ...action,
    title:
      typeof action.title === "string"
        ? action.title
        : typeof entry.title === "string" && entry.title
          ? entry.title
          : legacyId,
  };
}

export function decisionProposalAction(rootDir: string, action: RepoTaskAction): RepoTaskAction {
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
    if (
      Object.hasOwn(action, "bodyFile") ||
      (Object.hasOwn(action, "body") && action.kind !== "decision-relation-replace")
    )
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
  const packet = fromFile
      ? packetFile(rootDir, action.fromFile, decisionProposalFields).value
      : packetJson(action.jsonInput, decisionProposalFields),
    body =
      typeof action.body === "string"
        ? action.body
        : typeof action.bodyFile === "string"
          ? workspaceText(rootDir, action.bodyFile, "bodyFile")
          : `\n# ${requiredCellText(packet.title, "title")}\n`;
  return { kind: "decision-propose", ...packet, body };
}
