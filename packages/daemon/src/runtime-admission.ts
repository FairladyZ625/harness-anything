import {
  defaultLifecycleTaskProjectionPath,
  readTaskProjectionSchemaVersion,
  taskProjectionSchemaVersion,
} from "../../kernel/src/index.ts";

export interface DaemonRuntimeAdmissionGuard {
  readonly assert: (rootDir: string, force?: boolean) => void;
}
const schemaAdmissionRecheckMs = 5_000;

export class DaemonAdmissionError extends Error {
  readonly code: "kernel_schema_mismatch";
  constructor(code: "kernel_schema_mismatch", message: string) {
    super(message);
    this.name = "DaemonAdmissionError";
    this.code = code;
  }
}

export function makeDaemonRuntimeAdmissionGuard(
  options: { readonly nowMs?: () => number; readonly schemaRecheckMs?: number } = {},
): DaemonRuntimeAdmissionGuard {
  const nowMs = options.nowMs ?? Date.now,
    recheckMs = options.schemaRecheckMs ?? schemaAdmissionRecheckMs;
  let schemaAdmittedAt = Number.NEGATIVE_INFINITY;
  return {
    assert: (rootDir, force = false) => {
      const observedAt = nowMs();
      if (!force && observedAt >= schemaAdmittedAt && observedAt - schemaAdmittedAt < recheckMs) return;
      assertProjectionSchema(rootDir);
      schemaAdmittedAt = observedAt;
    },
  };
}

function assertProjectionSchema(rootDir: string): void {
  const projectionPath = defaultLifecycleTaskProjectionPath(rootDir),
    observed = readTaskProjectionSchemaVersion(projectionPath);
  if (observed !== null && observed > taskProjectionSchemaVersion)
    throw new DaemonAdmissionError(
      "kernel_schema_mismatch",
      `kernel projection schema ${observed} is newer than daemon schema ${taskProjectionSchemaVersion}; run a daemon build that understands the cache before reopening ${projectionPath}.`,
    );
}
