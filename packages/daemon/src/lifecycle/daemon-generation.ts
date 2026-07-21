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
  statSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { hostname } from "node:os";
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
  readonly runExclusive: <Result>(operation: () => Promise<Result>) => Promise<Result>;
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
  let lost: DaemonGenerationWitnessLostError | undefined;
  const assertCurrent = () => {
    if (lost) throw lost;
    let observed: DaemonGenerationRecordV1 | undefined;
    try {
      observed = readDaemonGenerationRecord(source);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (observed?.machineId !== expected.machineId
      || observed.daemonGeneration !== expected.daemonGeneration
      || observed.endpointIdentity !== input.endpointIdentity) {
      lost = new DaemonGenerationWitnessLostError(expected, observed);
      throw lost;
    }
  };
  return {
    ...expected,
    assertCurrent,
    runExclusive: (operation) => {
      if (lost) return Promise.reject(lost);
      return withDaemonGenerationMutationLockAsync(input, async () => {
        assertCurrent();
        return operation();
      });
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
  return withDaemonGenerationMutationLock(input, () => {
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
  });
}

interface DaemonGenerationMutationLockRecord {
  readonly schema: "daemon-generation-mutation-lock/v1";
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly ownerToken: string;
}

function withDaemonGenerationMutationLock<Result>(
  input: { readonly userRoot: string; readonly endpointIdentity: string },
  operation: () => Result
): Result {
  const lockPath = `${daemonGenerationRecordPath(input.userRoot, input.endpointIdentity)}.lock`;
  const ownerToken = acquireDaemonGenerationMutationLock(lockPath);
  try {
    return operation();
  } finally {
    releaseDaemonGenerationMutationLock(lockPath, ownerToken);
  }
}

async function withDaemonGenerationMutationLockAsync<Result>(
  input: { readonly userRoot: string; readonly endpointIdentity: string },
  operation: () => Promise<Result>
): Promise<Result> {
  const lockPath = `${daemonGenerationRecordPath(input.userRoot, input.endpointIdentity)}.lock`;
  const ownerToken = acquireDaemonGenerationMutationLock(lockPath);
  try {
    return await operation();
  } finally {
    releaseDaemonGenerationMutationLock(lockPath, ownerToken);
  }
}

function acquireDaemonGenerationMutationLock(lockPath: string): string {
  const ownerToken = randomBytes(12).toString("hex");
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    const temporary = `${lockPath}.${process.pid}.${ownerToken}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeSync(descriptor, JSON.stringify({
        schema: "daemon-generation-mutation-lock/v1",
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
        ownerToken
      } satisfies DaemonGenerationMutationLockRecord));
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(temporary, lockPath);
      return ownerToken;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      recoverAbandonedDaemonGenerationMutationLock(lockPath);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }
  throw new Error(`timed out acquiring daemon generation mutation lock: ${lockPath}`);
}

function recoverAbandonedDaemonGenerationMutationLock(lockPath: string): void {
  let record: DaemonGenerationMutationLockRecord | undefined;
  try {
    record = JSON.parse(readFileSync(lockPath, "utf8")) as DaemonGenerationMutationLockRecord;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs <= 30_000) return;
      const quarantine = `${lockPath}.invalid.${randomBytes(6).toString("hex")}`;
      renameSync(lockPath, quarantine);
      rmSync(quarantine, { force: true });
    } catch {
      // A live owner may still be publishing its record, or another contender recovered it.
    }
    return;
  }
  const ageMs = Date.now() - Date.parse(record.acquiredAt);
  const abandoned = record.schema === "daemon-generation-mutation-lock/v1"
    && (record.hostname === hostname() ? !processIsAlive(record.pid) : Number.isFinite(ageMs) && ageMs > 30_000);
  if (!abandoned) return;
  const quarantine = `${lockPath}.stale.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lockPath, quarantine);
    rmSync(quarantine, { force: true });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function releaseDaemonGenerationMutationLock(lockPath: string, ownerToken: string): void {
  let record: DaemonGenerationMutationLockRecord;
  try {
    record = JSON.parse(readFileSync(lockPath, "utf8")) as DaemonGenerationMutationLockRecord;
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (record.ownerToken !== ownerToken) throw new Error("daemon generation mutation lock ownership changed");
  rmSync(lockPath);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
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
