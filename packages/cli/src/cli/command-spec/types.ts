import type { ParsedCommand } from "../types.ts";

export type CommandParserId =
  | "help"
  | "version"
  | "core-task"
  | "new-task"
  | "decision"
  | "distill"
  | "record"
  | "runtime-event"
  | "materializer"
  | "session"
  | "doc"
  | "status-check"
  | "migration"
  | "git-diff"
  | "doctor"
  | "graph"
  | "capabilities"
  | "gui"
  | "template"
  | "preset"
  | "script"
  | "module"
  | "vertical";

export type CommandRunnerId =
  | "help"
  | "version"
  | "init"
  | "new-task"
  | "decision"
  | "distill"
  | "fact"
  | "runtime-event"
  | "materializer"
  | "session"
  | "doc"
  | "task-lifecycle"
  | "task-gates"
  | "task-query"
  | "governance"
  | "migration"
  | "diagnostics"
  | "extension"
  | "capabilities"
  | "gui";

export type RuntimeEventPolicy = "auto" | "direct" | "none" | "deferred";

export interface CommandReceiptContract {
  readonly data: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
  readonly optionalData?: Readonly<Record<string, string>>;
  readonly optionalPaths?: Readonly<Record<string, string>>;
}

export interface CommandEventPolicySpec {
  readonly conflictMarkerPreflight: boolean;
  readonly runtimeEvent: RuntimeEventPolicy;
}

export interface CommandSpecDefinition {
  readonly kind: string;
  readonly usage: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly summary: string;
  readonly examples: ReadonlyArray<string>;
  readonly parserId: CommandParserId;
  readonly runnerId: CommandRunnerId;
  readonly receiptContract: CommandReceiptContract;
  readonly eventPolicy: CommandEventPolicySpec;
}

export type ParsedCommandKind = ParsedCommand["action"]["kind"];

export function defineCommandSpecs<const Spec extends ReadonlyArray<CommandSpecDefinition>>(specs: Spec): Spec {
  return specs;
}
