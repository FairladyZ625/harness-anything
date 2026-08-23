import type { ActorAxes, ContractValidationIssue } from "./task.ts";
import { normalizeCommandEnvelope, validateNormalizedCommandEnvelope } from "./write-chain.contract.ts";
import type { WriteSource } from "./write-chain.contract.ts";
import type {
  NormalizedTaskLifecycleCommand,
  TaskLifecycleCommand,
  TaskLifecycleCommandIntent,
} from "./task-lifecycle-contract-internal-types.ts";

// Command envelope normalization and validation.
export function normalizeTaskLifecycleCommand<C extends TaskLifecycleCommandIntent>(
  binding: {
    readonly workspaceId: string;
    readonly actor: ActorAxes;
    readonly source: WriteSource;
    readonly expectedRevision: number;
  },
  command: C,
): NormalizedTaskLifecycleCommand<C> {
  return Object.freeze({
    ...command,
    ...normalizeCommandEnvelope({
      ...binding,
      command: command as unknown as Readonly<Record<string, unknown>>,
    }),
  }) as unknown as NormalizedTaskLifecycleCommand<C>;
}
function intent(command: TaskLifecycleCommand): TaskLifecycleCommandIntent {
  const {
    schema: _schema,
    workspaceId: _workspaceId,
    actor: _actor,
    source: _source,
    expectedRevision: _expectedRevision,
    opId: _opId,
    commandDigest: _commandDigest,
    eventId: _eventId,
    workspaceRevision: _workspaceRevision,
    occurredAt: _occurredAt,
    transport: _transport,
    ...value
  } = command as TaskLifecycleCommand & { readonly transport?: unknown };
  return value as TaskLifecycleCommandIntent;
}
export function validateTaskLifecycleCommandEnvelope(
  command: TaskLifecycleCommand,
): readonly ContractValidationIssue[] {
  return validateNormalizedCommandEnvelope(command, {
    workspaceId: command.workspaceId,
    actor: command.actor,
    source: command.source,
    expectedRevision: command.expectedRevision,
    command: intent(command) as unknown as Readonly<Record<string, unknown>>,
  }).map((message) => ({ code: "invalid_schema", message }));
}
