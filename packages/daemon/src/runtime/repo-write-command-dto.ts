import {
  decodeTaskCompleteTransitionCommand,
  type TaskCompleteTransitionCommand
} from "@harness-anything/application";
import type { RepoWriteJsonObject } from "./repo-write-protocol.ts";

declare const repoWriteLegacyCommandNameBrand: unique symbol;
export type RepoWriteLegacyCommandName = string & {
  readonly [repoWriteLegacyCommandNameBrand]: "not-task-complete";
};

export interface RepoWriteLegacyCommandDto {
  readonly commandName: RepoWriteLegacyCommandName;
  readonly actor: RepoWriteJsonObject;
  readonly context: RepoWriteJsonObject;
  readonly payload: RepoWriteJsonObject;
}

export interface RepoWriteTaskCompleteWireCommand {
  readonly rootDir: string;
  readonly rootResolutionSource?: "explicit-override" | "local-cwd";
  readonly layoutOverrides?: RepoWriteJsonObject;
  readonly daemonRepoId?: string;
  readonly actor?: string;
  readonly daemonModeOverride?: "direct" | "local" | "remote";
  readonly daemonProfileOverride?: "default" | "isolated";
  readonly json: boolean;
  readonly deprecatedInvocation?: RepoWriteJsonObject;
  readonly action: TaskCompleteTransitionCommand;
}

export interface RepoWriteTaskCompleteWireSession {
  readonly runtime: "human" | "claude-code" | "codex" | "zcode" | "antigravity";
  readonly sessionId: string;
  readonly source: "runtime" | "manual";
  readonly detectedAt: string;
  readonly user?: string;
}

export interface RepoWriteTaskCompleteCommandPayload {
  readonly command: RepoWriteTaskCompleteWireCommand;
  readonly session: RepoWriteTaskCompleteWireSession;
}

export interface RepoWriteTaskCompleteCommandDto {
  readonly commandName: "task-complete";
  readonly actor: RepoWriteJsonObject;
  readonly context: RepoWriteJsonObject;
  readonly payload: RepoWriteTaskCompleteCommandPayload;
}

export type RepoWriteCommandDto =
  | RepoWriteLegacyCommandDto
  | RepoWriteTaskCompleteCommandDto;

type Invalid = (path: string, expected: string) => never;

export function repoWriteLegacyCommandName(value: string): RepoWriteLegacyCommandName {
  if (value === "task-complete") {
    throw new Error("REPO_WRITE_TASK_COMPLETE_TYPED_COMMAND_REQUIRED");
  }
  return value as RepoWriteLegacyCommandName;
}

export function repoWriteCommandDtoFromDecodedFields(input: {
  readonly commandName: string;
  readonly actor: RepoWriteJsonObject;
  readonly context: RepoWriteJsonObject;
  readonly payload: RepoWriteJsonObject;
}, path = "$.command", invalid: Invalid = commandInvalid): RepoWriteCommandDto {
  if (input.commandName !== "task-complete") {
    return { ...input, commandName: repoWriteLegacyCommandName(input.commandName) };
  }
  return {
    ...input,
    commandName: "task-complete",
    payload: decodeTaskCompleteCommandPayload(input.payload, `${path}.payload`, invalid)
  };
}

function decodeTaskCompleteCommandPayload(
  payload: RepoWriteJsonObject,
  path: string,
  invalid: Invalid
): RepoWriteTaskCompleteCommandPayload {
  const payloadKeys = Object.keys(payload);
  if (payloadKeys.length !== 2 || !payloadKeys.includes("command") || !payloadKeys.includes("session")) {
    invalid(path, "typed task-complete payload with required command/session and no unknown keys");
  }
  const command = taskCompleteWireRecord(payload.command, `${path}.command`, invalid);
  taskCompleteWireExactKeys(command, ["rootDir", "json", "action"], [
    "rootResolutionSource", "layoutOverrides", "daemonRepoId", "actor",
    "daemonModeOverride", "daemonProfileOverride", "deprecatedInvocation"
  ], `${path}.command`, invalid);
  const action = decodeTaskCompleteTransitionCommand(
    command.action,
    `${path}.command.action`
  );
  const session = taskCompleteWireRecord(payload.session, `${path}.session`, invalid);
  taskCompleteWireExactKeys(
    session,
    ["runtime", "sessionId", "source", "detectedAt"],
    ["user"],
    `${path}.session`,
    invalid
  );
  if (typeof command.rootDir !== "string" || !command.rootDir.trim()) {
    invalid(`${path}.command.rootDir`, "non-empty string");
  }
  if (typeof command.json !== "boolean") invalid(`${path}.command.json`, "boolean");
  const rootResolutionSource = optionalEnum(
    command.rootResolutionSource,
    ["explicit-override", "local-cwd"],
    `${path}.command.rootResolutionSource`,
    invalid
  );
  const daemonModeOverride = optionalEnum(
    command.daemonModeOverride,
    ["direct", "local", "remote"],
    `${path}.command.daemonModeOverride`,
    invalid
  );
  const daemonProfileOverride = optionalEnum(
    command.daemonProfileOverride,
    ["default", "isolated"],
    `${path}.command.daemonProfileOverride`,
    invalid
  );
  const runtime = requiredEnum(
    session.runtime,
    ["human", "claude-code", "codex", "zcode", "antigravity"],
    `${path}.session.runtime`,
    invalid
  );
  const source = requiredEnum(
    session.source,
    ["runtime", "manual"],
    `${path}.session.source`,
    invalid
  );
  return {
    command: {
      rootDir: command.rootDir,
      ...(rootResolutionSource ? { rootResolutionSource } : {}),
      ...(command.layoutOverrides === undefined
        ? {}
        : { layoutOverrides: taskCompleteWireRecord(command.layoutOverrides, `${path}.command.layoutOverrides`, invalid) as RepoWriteJsonObject }),
      ...(command.daemonRepoId === undefined
        ? {}
        : { daemonRepoId: nonEmptyString(command.daemonRepoId, `${path}.command.daemonRepoId`, invalid) }),
      ...(command.actor === undefined
        ? {}
        : { actor: nonEmptyString(command.actor, `${path}.command.actor`, invalid) }),
      ...(daemonModeOverride ? { daemonModeOverride } : {}),
      ...(daemonProfileOverride ? { daemonProfileOverride } : {}),
      json: command.json,
      ...(command.deprecatedInvocation === undefined
        ? {}
        : { deprecatedInvocation: taskCompleteWireRecord(command.deprecatedInvocation, `${path}.command.deprecatedInvocation`, invalid) as RepoWriteJsonObject }),
      action
    },
    session: {
      runtime,
      sessionId: nonEmptyString(session.sessionId, `${path}.session.sessionId`, invalid),
      source,
      detectedAt: nonEmptyString(session.detectedAt, `${path}.session.detectedAt`, invalid),
      ...(session.user === undefined
        ? {}
        : { user: nonEmptyString(session.user, `${path}.session.user`, invalid) })
    }
  };
}

function taskCompleteWireRecord(value: unknown, path: string, invalid: Invalid): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "plain object");
  return value as Record<string, unknown>;
}

function taskCompleteWireExactKeys(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
  path: string,
  invalid: Invalid
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))) {
    invalid(path, "exact message fields");
  }
}

function optionalEnum<const T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  path: string,
  invalid: Invalid
): T | undefined {
  return value === undefined ? undefined : requiredEnum(value, allowed, path, invalid);
}

function requiredEnum<const T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  path: string,
  invalid: Invalid
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(path, allowed.join(", "));
  }
  return value as T;
}

function nonEmptyString(value: unknown, path: string, invalid: Invalid): string {
  if (typeof value !== "string" || !value.trim()) invalid(path, "non-empty string");
  return value;
}

function commandInvalid(path: string, expected: string): never {
  throw new Error(`REPO_WRITE_TASK_COMPLETE_COMMAND_INVALID:${path}:${expected}`);
}
