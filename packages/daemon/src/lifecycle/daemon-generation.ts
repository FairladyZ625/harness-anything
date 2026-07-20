import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export const daemonGenerationRecordSchema = "daemon-generation-record/v1" as const;

export interface DaemonGenerationRecordV1 {
  readonly schema: typeof daemonGenerationRecordSchema;
  readonly machineId: string;
  readonly endpointIdentity: string;
  readonly daemonGeneration: number;
  readonly daemonInstanceId: string;
  readonly publishedAt: string;
}

export function daemonMachineIdPath(installationRoot: string): string {
  return path.join(path.resolve(installationRoot), "machine-id");
}

export function daemonGenerationRecordPath(userRoot: string, endpointIdentity: string): string {
  const endpointHash = createHash("sha256").update(endpointIdentity).digest("hex");
  return path.join(path.resolve(userRoot), `daemon-generation.${endpointHash}.json`);
}

/** Installation-scoped identity. Different userRoot values intentionally receive different identities. */
export function readOrCreateDaemonMachineId(installationRoot: string): string {
  const directory = path.resolve(installationRoot);
  const target = daemonMachineIdPath(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(target)) return readMachineId(target);

  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${randomUUID()}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return readMachineId(target);
}

/**
 * Publish the next generation after the caller has acquired the endpoint owner fence.
 * The owner serialization is what makes read + replace strictly monotonic.
 */
export function publishNextDaemonGeneration(input: {
  readonly userRoot: string;
  readonly endpointIdentity: string;
  readonly machineId: string;
  readonly daemonInstanceId: string;
  readonly now?: () => Date;
}): DaemonGenerationRecordV1 {
  assertNonEmpty(input.endpointIdentity, "endpointIdentity");
  assertNonEmpty(input.machineId, "machineId");
  assertNonEmpty(input.daemonInstanceId, "daemonInstanceId");
  const directory = path.resolve(input.userRoot);
  const target = daemonGenerationRecordPath(directory, input.endpointIdentity);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const current = existsSync(target) ? readDaemonGenerationRecord(target) : undefined;
  if (current && (current.machineId !== input.machineId || current.endpointIdentity !== input.endpointIdentity)) {
    throw new Error("daemon generation record identity mismatch");
  }
  if (current?.daemonGeneration === Number.MAX_SAFE_INTEGER) {
    throw new Error("daemon generation space exhausted");
  }
  const record: DaemonGenerationRecordV1 = {
    schema: daemonGenerationRecordSchema,
    machineId: input.machineId,
    endpointIdentity: input.endpointIdentity,
    daemonGeneration: (current?.daemonGeneration ?? 0) + 1,
    daemonInstanceId: input.daemonInstanceId,
    publishedAt: (input.now ?? (() => new Date()))().toISOString()
  };
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return record;
}

export function readDaemonGenerationRecord(source: string): DaemonGenerationRecordV1 {
  const parsed: unknown = JSON.parse(readFileSync(source, "utf8"));
  if (!isDaemonGenerationRecord(parsed)) throw new Error(`invalid daemon generation record: ${source}`);
  return parsed;
}

function readMachineId(source: string): string {
  const machineId = readFileSync(source, "utf8").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(machineId)) {
    throw new Error(`invalid daemon machine identity: ${source}`);
  }
  return machineId;
}

function isDaemonGenerationRecord(value: unknown): value is DaemonGenerationRecordV1 {
  if (!record(value) || Object.keys(value).length !== 6) return false;
  return value.schema === daemonGenerationRecordSchema
    && typeof value.machineId === "string" && value.machineId.length > 0
    && typeof value.endpointIdentity === "string" && value.endpointIdentity.length > 0
    && typeof value.daemonGeneration === "number" && Number.isSafeInteger(value.daemonGeneration) && value.daemonGeneration >= 1
    && typeof value.daemonInstanceId === "string" && value.daemonInstanceId.length > 0
    && typeof value.publishedAt === "string" && Number.isFinite(Date.parse(value.publishedAt));
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new Error(`${field} must be non-empty`);
}
