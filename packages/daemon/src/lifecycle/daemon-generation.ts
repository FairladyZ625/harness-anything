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
export const daemonGenerationDurabilityUnsupportedCode = "DAEMON_GENERATION_DURABILITY_UNSUPPORTED" as const;

export interface DaemonGenerationRecordV1 {
  readonly schema: typeof daemonGenerationRecordSchema;
  readonly machineId: string;
  readonly endpointIdentity: string;
  readonly daemonGeneration: number;
  readonly daemonInstanceId: string;
  readonly publishedAt: string;
}

export type DaemonGenerationServePreparation = {
  readonly mode: "generation";
  readonly machineId: string;
  readonly daemonGeneration: number;
  readonly witness: DaemonGenerationWitness;
} | {
  readonly mode: "legacy";
  readonly diagnostic: typeof daemonGenerationDurabilityUnsupportedCode;
};

export interface DaemonGenerationWitness {
  readonly machineId: string;
  readonly daemonGeneration: number;
  readonly assertCurrent: () => void;
}

export class DaemonGenerationWitnessLostError extends Error {
  readonly expected: Pick<DaemonGenerationRecordV1, "machineId" | "daemonGeneration">;
  readonly observed: Pick<DaemonGenerationRecordV1, "machineId" | "daemonGeneration"> | undefined;

  constructor(
    expected: Pick<DaemonGenerationRecordV1, "machineId" | "daemonGeneration">,
    observed: Pick<DaemonGenerationRecordV1, "machineId" | "daemonGeneration"> | undefined
  ) {
    super(
      `daemon generation witness lost: expected ${expected.machineId}/${expected.daemonGeneration}, `
      + `observed ${observed ? `${observed.machineId}/${observed.daemonGeneration}` : "missing"}`
    );
    this.name = "DaemonGenerationWitnessLostError";
    this.expected = expected;
    this.observed = observed;
  }
}

export function daemonMachineIdPath(installationRoot: string): string {
  return path.join(path.resolve(installationRoot), "machine-id");
}

export function daemonGenerationRecordPath(userRoot: string, endpointIdentity: string): string {
  const endpointHash = createHash("sha256").update(endpointIdentity).digest("hex");
  return path.join(path.resolve(userRoot), `daemon-generation.${endpointHash}.json`);
}

/** Default daemon startup remains legacy-compatible where durable generation publication is unavailable. */
export function prepareDaemonGenerationForServe(input: {
  readonly userRoot: string;
  readonly endpointIdentity: string;
  readonly daemonInstanceId: string;
  readonly platform?: NodeJS.Platform;
}): DaemonGenerationServePreparation {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    return { mode: "legacy", diagnostic: daemonGenerationDurabilityUnsupportedCode };
  }
  const machineId = readOrCreateDaemonMachineId(input.userRoot, platform);
  const generationRecord = publishNextDaemonGeneration({
    userRoot: input.userRoot,
    endpointIdentity: input.endpointIdentity,
    machineId,
    daemonInstanceId: input.daemonInstanceId,
    platform
  });
  return {
    mode: "generation",
    machineId,
    daemonGeneration: generationRecord.daemonGeneration,
    witness: createDaemonGenerationWitness({
      userRoot: input.userRoot,
      endpointIdentity: input.endpointIdentity,
      machineId,
      daemonGeneration: generationRecord.daemonGeneration,
      platform
    })
  };
}

/** A narrow durable-current witness. S1.3 composes it with the repo authority fence. */
export function createDaemonGenerationWitness(input: {
  readonly userRoot: string;
  readonly endpointIdentity: string;
  readonly machineId: string;
  readonly daemonGeneration: number;
  readonly platform?: NodeJS.Platform;
}): DaemonGenerationWitness {
  assertDurableGenerationPlatform(input.platform ?? process.platform);
  const source = daemonGenerationRecordPath(input.userRoot, input.endpointIdentity);
  const expected = { machineId: input.machineId, daemonGeneration: input.daemonGeneration };
  return {
    ...expected,
    assertCurrent: () => {
      let observed: DaemonGenerationRecordV1 | undefined;
      try {
        observed = readDaemonGenerationRecord(source);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      if (observed?.machineId !== expected.machineId
        || observed.daemonGeneration !== expected.daemonGeneration
        || observed.endpointIdentity !== input.endpointIdentity) {
        throw new DaemonGenerationWitnessLostError(expected, observed);
      }
    }
  };
}

/** Installation-scoped identity. Different userRoot values intentionally receive different identities. */
export function readOrCreateDaemonMachineId(
  installationRoot: string,
  platform: NodeJS.Platform = process.platform
): string {
  assertDurableGenerationPlatform(platform);
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
  readonly platform?: NodeJS.Platform;
}): DaemonGenerationRecordV1 {
  assertDurableGenerationPlatform(input.platform ?? process.platform);
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
  if (!isJsonRecord(value) || Object.keys(value).length !== 6) return false;
  return value.schema === daemonGenerationRecordSchema
    && typeof value.machineId === "string" && value.machineId.length > 0
    && typeof value.endpointIdentity === "string" && value.endpointIdentity.length > 0
    && typeof value.daemonGeneration === "number" && Number.isSafeInteger(value.daemonGeneration) && value.daemonGeneration >= 1
    && typeof value.daemonInstanceId === "string" && value.daemonInstanceId.length > 0
    && typeof value.publishedAt === "string" && Number.isFinite(Date.parse(value.publishedAt));
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertDurableGenerationPlatform(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new Error(
      `${daemonGenerationDurabilityUnsupportedCode}: Windows daemon generation publication is disabled until a crash-durable directory replacement primitive is available.`
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new Error(`${field} must be non-empty`);
}
