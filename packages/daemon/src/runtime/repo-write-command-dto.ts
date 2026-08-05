import {
  decodeRepoWriteCommandAction,
  decodeRepoWriteDeprecatedCommandInvocation,
  decodeRepoWriteDocSyncSubmitRequest,
  decodeRepoWriteHarnessLayoutOverrides,
  decodeTaskCompleteTransitionCommand,
  decodeTaskSubmitTransitionCommand,
  type DocSyncSubmitRequestV1,
  type DeprecatedCommandInvocation,
  type RepoWriteCommandAction,
  type RepoWriteCommandActionKind,
  type TaskCompleteTransitionCommand,
  type TaskSubmitTransitionCommand
} from "@harness-anything/application";
import type { HarnessLayoutOverrides } from "@harness-anything/kernel";
import type { RepoWriteJsonObject } from "./repo-write-protocol.ts";

interface RepoWriteCliWireCommand<Action> {
  readonly rootDir: string;
  readonly rootResolutionSource?: "explicit-override" | "local-cwd";
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly daemonRepoId?: string;
  readonly actor?: string;
  readonly daemonModeOverride?: "direct" | "local" | "remote";
  readonly daemonProfileOverride?: "default" | "isolated";
  readonly json: boolean;
  readonly deprecatedInvocation?: DeprecatedCommandInvocation;
  readonly action: Action;
}

interface RepoWriteDocSyncWireCommand {
  readonly rootDir: string;
  readonly action: { readonly kind: "doc-sync-submit" };
  readonly request: DocSyncSubmitRequestV1;
}

interface RepoWriteWireSession {
  readonly runtime: "human" | "claude-code" | "codex" | "zcode" | "antigravity";
  readonly sessionId: string;
  readonly source: "runtime" | "manual";
  readonly detectedAt: string;
  readonly user?: string;
}

type RepoWriteTransportAction =
  | RepoWriteCommandAction
  | TaskCompleteTransitionCommand
  | TaskSubmitTransitionCommand
  | { readonly kind: "doc-sync-submit" };

export type RepoWriteCommandName = RepoWriteTransportAction["kind"];

type RepoWriteWireCommandFor<Name extends RepoWriteCommandName> =
  Name extends "task-complete"
    ? RepoWriteCliWireCommand<TaskCompleteTransitionCommand>
    : Name extends "task-submit"
      ? RepoWriteCliWireCommand<TaskSubmitTransitionCommand>
      : Name extends "doc-sync-submit"
        ? RepoWriteDocSyncWireCommand
        : RepoWriteCliWireCommand<Extract<RepoWriteCommandAction, { readonly kind: Name }>>;

export interface RepoWriteCommandPayload<Name extends RepoWriteCommandName> {
  readonly command: RepoWriteWireCommandFor<Name>;
  readonly session: RepoWriteWireSession;
}

export type RepoWriteCommandDtoFor<Name extends RepoWriteCommandName> = {
  readonly commandName: Name;
  readonly actor: RepoWriteJsonObject;
  readonly context: RepoWriteJsonObject;
  readonly payload: RepoWriteCommandPayload<Name>;
};

/** commandName and payload.action.kind are correlated for every registered writer command. */
export type RepoWriteCommandDto = {
  [Name in RepoWriteCommandName]: RepoWriteCommandDtoFor<Name>
}[RepoWriteCommandName];

type Invalid = (path: string, expected: string) => never;

export function repoWriteCommandDtoFromDecodedFields(input: {
  readonly commandName: string;
  readonly actor: RepoWriteJsonObject;
  readonly context: RepoWriteJsonObject;
  readonly payload: RepoWriteJsonObject;
}, path = "$.command", invalid: Invalid = commandInvalid): RepoWriteCommandDto {
  const payload = decodeCommandPayload(
    input.commandName,
    input.payload,
    `${path}.payload`,
    invalid
  );
  return {
    commandName: input.commandName,
    actor: input.actor,
    context: input.context,
    payload
  } as RepoWriteCommandDto;
}

function decodeCommandPayload(
  commandName: string,
  payload: RepoWriteJsonObject,
  path: string,
  invalid: Invalid
): RepoWriteCommandPayload<RepoWriteCommandName> {
  repoWriteWireExactKeys(payload, ["command", "session"], [], path, invalid);
  const command = wireRecord(payload.command, `${path}.command`, invalid);
  const session = decodeSession(payload.session, `${path}.session`, invalid);
  if (commandName === "doc-sync-submit") {
    repoWriteWireExactKeys(command, ["rootDir", "action", "request"], [], `${path}.command`, invalid);
    const action = wireRecord(command.action, `${path}.command.action`, invalid);
    repoWriteWireExactKeys(action, ["kind"], [], `${path}.command.action`, invalid);
    if (action.kind !== "doc-sync-submit") {
      invalid(`${path}.command.action.kind`, "doc-sync-submit");
    }
    return {
      command: {
        rootDir: nonEmptyString(command.rootDir, `${path}.command.rootDir`, invalid),
        action: { kind: "doc-sync-submit" },
        request: decodeRepoWriteDocSyncSubmitRequest(
          command.request,
          `${path}.command.request`
        )
      },
      session
    };
  }

  repoWriteWireExactKeys(command, ["rootDir", "json", "action"], [
    "rootResolutionSource", "layoutOverrides", "daemonRepoId", "actor",
    "daemonModeOverride", "daemonProfileOverride", "deprecatedInvocation"
  ], `${path}.command`, invalid);
  if (typeof command.json !== "boolean") invalid(`${path}.command.json`, "boolean");
  const action = decodeCliAction(commandName, command.action, `${path}.command.action`, invalid);
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
  return {
    command: {
      rootDir: nonEmptyString(command.rootDir, `${path}.command.rootDir`, invalid),
      ...(rootResolutionSource ? { rootResolutionSource } : {}),
      ...(command.layoutOverrides === undefined ? {} : {
        layoutOverrides: decodeRepoWriteHarnessLayoutOverrides(
          command.layoutOverrides,
          `${path}.command.layoutOverrides`
        )
      }),
      ...(command.daemonRepoId === undefined ? {} : {
        daemonRepoId: nonEmptyString(command.daemonRepoId, `${path}.command.daemonRepoId`, invalid)
      }),
      ...(command.actor === undefined ? {} : {
        actor: nonEmptyString(command.actor, `${path}.command.actor`, invalid)
      }),
      ...(daemonModeOverride ? { daemonModeOverride } : {}),
      ...(daemonProfileOverride ? { daemonProfileOverride } : {}),
      json: command.json,
      ...(command.deprecatedInvocation === undefined ? {} : {
        deprecatedInvocation: decodeRepoWriteDeprecatedCommandInvocation(
          command.deprecatedInvocation,
          `${path}.command.deprecatedInvocation`
        )
      }),
      action
    },
    session
  } as RepoWriteCommandPayload<RepoWriteCommandName>;
}

function decodeCliAction(
  commandName: string,
  value: unknown,
  path: string,
  invalid: Invalid
): RepoWriteCommandAction | TaskCompleteTransitionCommand | TaskSubmitTransitionCommand {
  let action: RepoWriteCommandAction | TaskCompleteTransitionCommand | TaskSubmitTransitionCommand;
  if (commandName === "task-complete") {
    action = decodeTaskCompleteTransitionCommand(value, path);
  } else if (commandName === "task-submit") {
    action = decodeTaskSubmitTransitionCommand(value, path);
  } else {
    action = decodeRepoWriteCommandAction(value, path);
  }
  if (action.kind !== commandName) {
    invalid(`${path}.kind`, `the same command kind as ${commandName}`);
  }
  return action;
}

function decodeSession(value: unknown, path: string, invalid: Invalid): RepoWriteWireSession {
  const session = wireRecord(value, path, invalid);
  repoWriteWireExactKeys(session, ["runtime", "sessionId", "source", "detectedAt"], ["user"], path, invalid);
  const runtime = requiredEnum(
    session.runtime,
    ["human", "claude-code", "codex", "zcode", "antigravity"],
    `${path}.runtime`,
    invalid
  );
  const source = requiredEnum(session.source, ["runtime", "manual"], `${path}.source`, invalid);
  return {
    runtime,
    sessionId: nonEmptyString(session.sessionId, `${path}.sessionId`, invalid),
    source,
    detectedAt: nonEmptyString(session.detectedAt, `${path}.detectedAt`, invalid),
    ...(session.user === undefined ? {} : {
      user: nonEmptyString(session.user, `${path}.user`, invalid)
    })
  };
}

function wireRecord(value: unknown, path: string, invalid: Invalid): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "plain object");
  return value as Record<string, unknown>;
}

function repoWriteWireExactKeys(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
  path: string,
  invalid: Invalid
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) invalid(`${path}.${missing}`, "required field");
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) invalid(`${path}.${unknown}`, "no unknown fields");
}

function optionalEnum<const Value extends string>(
  value: unknown,
  allowed: ReadonlyArray<Value>,
  path: string,
  invalid: Invalid
): Value | undefined {
  return value === undefined ? undefined : requiredEnum(value, allowed, path, invalid);
}

function requiredEnum<const Value extends string>(
  value: unknown,
  allowed: ReadonlyArray<Value>,
  path: string,
  invalid: Invalid
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    invalid(path, allowed.join(", "));
  }
  return value as Value;
}

function nonEmptyString(value: unknown, path: string, invalid: Invalid): string {
  if (typeof value !== "string" || !value.trim()) invalid(path, "non-empty string");
  return value;
}

function commandInvalid(path: string, expected: string): never {
  throw new Error(`REPO_WRITE_COMMAND_INVALID:${path}:${expected}`);
}

const applicationKindsAreNames = true satisfies
  RepoWriteCommandActionKind extends RepoWriteCommandName ? true : never;
void applicationKindsAreNames;
