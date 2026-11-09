import { isRecord } from "./contract-validation.ts";

export const HOST_PROCESS_LOCK_SCHEMA = "host-process-lock/v1" as const;
export const HOST_DIAGNOSTIC_LINE_SCHEMA = "host-diagnostic-line/v1" as const;

export const hostAggregateSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema" as const,
  $id: "host/v1",
  type: "object" as const,
  properties: {
    hostId: { type: "string" as const, const: "singleton" },
    process: { type: "string" as const, enum: ["running", "stopped"] },
  },
  required: ["hostId", "process"],
  additionalProperties: false,
});

export const hostProcessLockSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema" as const,
  $id: HOST_PROCESS_LOCK_SCHEMA,
  type: "object" as const,
  properties: {
    pid: { type: "integer" as const, minimum: 1 },
    token: { type: "string" as const, minLength: 1 },
    acquiredAt: { type: "string" as const, minLength: 1 },
  },
  required: ["pid", "token", "acquiredAt"],
  additionalProperties: false,
});

export const hostDiagnosticLineSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema" as const,
  $id: HOST_DIAGNOSTIC_LINE_SCHEMA,
  type: "object" as const,
  properties: {
    at: { type: "string" as const, minLength: 1 },
    level: { type: "string" as const, enum: ["debug", "info", "warn", "error"] },
    source: { type: "string" as const, minLength: 1 },
    message: { type: "string" as const, minLength: 1 },
  },
  required: ["at", "level", "source", "message"],
  additionalProperties: false,
});

export type HostProcessLock = {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
};

export type HostDiagnosticLine = {
  readonly at: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly source: string;
  readonly message: string;
};

export type HostProcessLockState =
  | { readonly status: "released" }
  | { readonly status: "held"; readonly lock: HostProcessLock };

export function reduceHostProcessLock(
  state: HostProcessLockState,
  event:
    | { readonly type: "acquired"; readonly lock: HostProcessLock }
    | { readonly type: "released"; readonly token: string },
): HostProcessLockState {
  if (event.type === "acquired") {
    if (state.status === "held") throw new Error("host process lock is already held");
    return { status: "held", lock: event.lock };
  }
  if (state.status === "released") throw new Error("host process lock is not held");
  if (state.lock.token !== event.token) throw new Error("host process lock token does not match");
  return { status: "released" };
}

export interface HostProcessLockPort {
  acquire(lock: HostProcessLock): void;
  release(lock: HostProcessLock): void;
}

export function withHostProcessLock<T>(lock: HostProcessLock, port: HostProcessLockPort, operation: () => T): T {
  const issues = validateHostProcessLock(lock);
  if (issues.length) throw new Error(issues.join("; "));
  port.acquire(lock);
  const held = reduceHostProcessLock({ status: "released" }, { type: "acquired", lock });
  try {
    return operation();
  } finally {
    reduceHostProcessLock(held, { type: "released", token: lock.token });
    port.release(lock);
  }
}

export function appendHostDiagnostic(
  lines: readonly HostDiagnosticLine[],
  line: HostDiagnosticLine,
): readonly HostDiagnosticLine[] {
  return Object.freeze([...lines, line]);
}

export function validateHostProcessLock(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["host process lock must be an object"];
  const errors: string[] = [];
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1) errors.push("pid must be a positive integer");
  if (typeof value.token !== "string" || value.token.length === 0) errors.push("token must be non-empty");
  if (typeof value.acquiredAt !== "string" || value.acquiredAt.length === 0)
    errors.push("acquiredAt must be non-empty");
  return errors;
}

export function validateHostDiagnosticLine(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["host diagnostic line must be an object"];
  const errors: string[] = [];
  if (typeof value.at !== "string" || value.at.length === 0) errors.push("at must be non-empty");
  if (!(["debug", "info", "warn", "error"] as const).includes(value.level as never)) errors.push("level is invalid");
  if (typeof value.source !== "string" || value.source.length === 0) errors.push("source must be non-empty");
  if (typeof value.message !== "string" || value.message.length === 0) errors.push("message must be non-empty");
  return errors;
}
