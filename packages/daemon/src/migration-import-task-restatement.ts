import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  canonicalizeContractValue,
  consumeKnownError,
  normalizePersistedCanonicalEvent,
  validateMigrationImportEvent,
  validatePresetSnapshotUpgradeEvent,
  validateTaskBootstrapEvent,
  validateTaskEvent,
  validateTaskV2,
  type PersistedCanonicalEventV1,
  type TaskV2,
} from "../../kernel/src/index.ts";

export interface LegacyTaskRestatement {
  readonly taskId: string;
  readonly pinned: boolean;
  readonly pinnedWasPresent: boolean;
  readonly sourceRevision: number;
  readonly sourcePath: string;
}

export interface TaskContractRestatementCounts {
  readonly sourceV1: number;
  readonly targetV2: number;
  readonly pinnedPreserved: number;
  readonly pinnedExplicitFalse: number;
  readonly importedSnapshot: number;
}

export interface LegacyTaskRestatementRead {
  readonly tasks: ReadonlyMap<string, LegacyTaskRestatement>;
  readonly sourcePaths: ReadonlySet<string>;
}

export interface LegacyTaskEventInput {
  readonly sourcePath: string;
  readonly value: unknown;
  readonly body?: string;
}

interface LegacyTaskSnapshot {
  readonly taskId: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly sourceRevision: number;
  readonly sourcePath: string;
  readonly createsIdentity: boolean;
}

export function readLegacyTaskRestatements(sourceRoot: string, authoredRoot: string): LegacyTaskRestatementRead {
  const eventsRoot = path.join(authoredRoot, "events"),
    inputs = listJsonFiles(eventsRoot)
      .filter((file) => path.basename(file) !== "head.json")
      .flatMap((file): readonly LegacyTaskEventInput[] => {
        try {
          const body = readFileSync(file, "utf8");
          return [
            {
              sourcePath: portablePath(path.relative(sourceRoot, file)),
              value: JSON.parse(body) as unknown,
              body,
            },
          ];
        } catch (error) {
          consumeKnownError(error);
          return [];
        }
      })
      .sort((left, right) => eventRevision(left.value) - eventRevision(right.value));
  return {
    tasks: restateLegacyTaskEvents(inputs),
    sourcePaths: new Set(
      inputs.filter((input) => legacyTaskSnapshot(input) !== null).map(({ sourcePath }) => sourcePath),
    ),
  };
}

export function restateLegacyTaskEvents(
  inputs: readonly LegacyTaskEventInput[],
): ReadonlyMap<string, LegacyTaskRestatement> {
  const latest = new Map<string, LegacyTaskRestatement>(),
    created = new Set<string>();
  let previousRevision = 0;
  for (const input of inputs) {
    const snapshot = legacyTaskSnapshot(input);
    if (snapshot === null) continue;
    if (input.body !== undefined && `${JSON.stringify(canonicalizeContractValue(input.value))}\n` !== input.body)
      throw new Error(`${snapshot.sourcePath}: legacy Task/v1 event bytes are not canonical`);
    if (snapshot.sourceRevision <= previousRevision)
      throw new Error(`legacy Task/v1 revisions must increase: ${snapshot.sourceRevision} follows ${previousRevision}`);
    previousRevision = snapshot.sourceRevision;
    if (snapshot.createsIdentity && created.has(snapshot.taskId))
      throw new Error(`legacy Task/v1 identity occurs more than once: ${snapshot.taskId}`);
    if (snapshot.createsIdentity) created.add(snapshot.taskId);
    const pinnedWasPresent = Object.hasOwn(snapshot.task, "pinned"),
      pinned = pinnedWasPresent ? snapshot.task.pinned : false,
      restated = { ...snapshot.task, schema: "task/v2", pinned };
    const issues = validateTaskV2(restated, true);
    if (issues.length)
      throw new Error(
        [
          `${snapshot.sourcePath}: Task/v1 cannot be restated as Task/v2: `,
          issues.map(({ message }) => message).join("; "),
        ].join(""),
      );
    const eventIssues = validateRestatedEvent(input.value, restated);
    if (eventIssues.length)
      throw new Error(`${snapshot.sourcePath}: legacy Task/v1 event is invalid: ${eventIssues.join("; ")}`);
    latest.set(snapshot.taskId, {
      taskId: snapshot.taskId,
      pinned: (restated as unknown as TaskV2).pinned,
      pinnedWasPresent,
      sourceRevision: snapshot.sourceRevision,
      sourcePath: snapshot.sourcePath,
    });
  }
  return latest;
}

function validateRestatedEvent(eventValue: unknown, task: Readonly<Record<string, unknown>>): readonly string[] {
  if (!migrationImportRecord(eventValue) || !migrationImportRecord(eventValue.payload))
    return ["event envelope or payload is invalid"];
  const payload = eventValue.payload;
  if (eventValue.schema === "migration-import-event/v1" && migrationImportRecord(payload.entity))
    return validateMigrationImportEvent(
      normalizePersistedCanonicalEvent({
        ...eventValue,
        payload: {
          ...payload,
          entity: { ...payload.entity, provenance: "imported_snapshot", task },
        },
      } as unknown as PersistedCanonicalEventV1),
    );
  const restated = normalizePersistedCanonicalEvent({
    ...eventValue,
    payload: { ...payload, task },
  } as unknown as PersistedCanonicalEventV1);
  if (eventValue.schema === "task-event/v1") return validateTaskEvent(restated).map(({ message }) => message);
  if (eventValue.schema === "task-bootstrap-event/v1") return validateTaskBootstrapEvent(restated);
  if (eventValue.schema === "preset-snapshot-upgrade-event/v1") return validatePresetSnapshotUpgradeEvent(restated);
  return ["Task/v1 is carried by an unsupported canonical event schema"];
}

export function taskContractRestatementCounts(
  source: ReadonlyMap<string, LegacyTaskRestatement>,
  targetTaskIds: readonly string[],
): TaskContractRestatementCounts {
  const targets = [...new Set(targetTaskIds)],
    sourceV1 = targets.filter((taskId) => source.has(taskId)).length,
    pinnedPreserved = targets.filter((taskId) => source.get(taskId)?.pinnedWasPresent === true).length;
  return Object.freeze({
    sourceV1,
    targetV2: targets.length,
    pinnedPreserved,
    pinnedExplicitFalse: targets.length - pinnedPreserved,
    importedSnapshot: targets.length,
  });
}

function legacyTaskSnapshot(input: LegacyTaskEventInput): LegacyTaskSnapshot | null {
  if (!migrationImportRecord(input.value) || !Number.isSafeInteger(input.value.workspaceRevision)) return null;
  const event = input.value,
    payload = migrationImportRecord(event.payload) ? event.payload : null;
  if (payload === null) return null;
  let task: Readonly<Record<string, unknown>> | null = null,
    createsIdentity = false;
  if (
    event.schema === "task-event/v1" ||
    event.schema === "task-bootstrap-event/v1" ||
    event.schema === "preset-snapshot-upgrade-event/v1"
  ) {
    task = migrationImportRecord(payload.task) ? payload.task : null;
    createsIdentity = event.type === "task_created" || event.type === "task_bootstrapped";
  } else if (event.schema === "migration-import-event/v1" && migrationImportRecord(payload.entity)) {
    task = payload.entity.kind === "task" && migrationImportRecord(payload.entity.task) ? payload.entity.task : null;
    createsIdentity = task !== null;
  }
  if (task?.schema !== "task/v1") return null;
  if (typeof task.taskId !== "string" || !task.taskId)
    throw new Error(`${input.sourcePath}: legacy Task/v1 taskId is missing`);
  return {
    taskId: task.taskId,
    task,
    sourceRevision: event.workspaceRevision as number,
    sourcePath: input.sourcePath,
    createsIdentity,
  };
}

function eventRevision(value: unknown): number {
  return migrationImportRecord(value) && Number.isSafeInteger(value.workspaceRevision)
    ? (value.workspaceRevision as number)
    : Number.MAX_SAFE_INTEGER;
}

function listJsonFiles(root: string): readonly string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .flatMap((entry) => {
        const target = path.join(root, entry.name);
        return entry.isDirectory()
          ? listJsonFiles(target)
          : entry.isFile() && entry.name.endsWith(".json")
            ? [target]
            : [];
      })
      .sort();
  } catch (error) {
    consumeKnownError(error);
    return [];
  }
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function migrationImportRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
