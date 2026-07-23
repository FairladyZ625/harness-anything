import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import type { CommandReceiptEnvelope } from "@harness-anything/application";
import { sha256Text } from "@harness-anything/kernel";
import {
  assertRepoWriteOutcomeAxesV1,
  canonicalRepoWriteOutcomeText,
  createRepoWriteProceedingOutcomeV1,
  createRepoWriteTerminalOutcomeV1,
  decodeRepoWriteOutcomeV1,
  repoWriteActorStampDigestV1,
  repoWriteReceiptSeedSchema,
  RepoWriteOutcomeValidationError,
  sameRepoWriteOutcomeImmutableFieldsV1,
  type RepoWriteOutcomeAxesV1,
  type RepoWriteOutcomeV1,
  type RepoWriteProceedingInputV1,
  type RepoWriteProceedingOutcomeV1,
  type RepoWriteTerminalEvidenceV1,
  type RepoWriteTerminalOutcomeV1
} from "./repo-write-outcome-schema.ts";

const proceedingSuffix = ".proceeding.json";
const terminalSuffix = ".terminal.json";
const maximumOutcomeBytes = 2 * 1_024 * 1_024;

export class RepoWriteOutcomeConflictError extends Error {
  readonly code = "REPO_WRITE_OUTCOME_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "RepoWriteOutcomeConflictError";
  }
}

export class RepoWriteOutcomeCorruptionError extends Error {
  readonly code = "REPO_WRITE_OUTCOME_CORRUPT";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RepoWriteOutcomeCorruptionError";
  }
}

export class RepoWriteOutcomeUnsupportedPlatformError extends Error {
  readonly code = "REPO_WRITE_OUTCOME_PLATFORM_UNSUPPORTED";

  constructor() {
    super("repo-write outcome durability is unsupported on win32");
    this.name = "RepoWriteOutcomeUnsupportedPlatformError";
  }
}

export class RepoWriteOutcomeGenerationFenceError extends Error {
  readonly code = "REPO_WRITE_OUTCOME_GENERATION_FENCED";

  constructor(message: string) {
    super(message);
    this.name = "RepoWriteOutcomeGenerationFenceError";
  }
}

type DirectoryFsyncReason = "publish" | "observe-existing" | "eexist-observer";
type TargetFsyncReason = "observe-existing" | "eexist-observer";

export interface RepoWriteOutcomeDurabilityTestHooks {
  /** Test-only fault injection; native fsync still runs unless this throws. */
  readonly beforeDirectoryFsync?: (reason: DirectoryFsyncReason) => void;
  /** Test-only race injection; cannot replace the native link/fsync sequence. */
  readonly beforePublishLink?: (input: { readonly target: string; readonly text: string }) => void;
  /** Test-only observation emitted after the native target-inode fsync succeeds. */
  readonly afterTargetFsync?: (
    input: { readonly reason: TargetFsyncReason; readonly target: string }
  ) => void;
}

export interface DurableRepoWriteOutcomeStoreV1Options extends RepoWriteOutcomeAxesV1 {
  readonly directory: string;
  readonly __testOnlyDurabilityHooks?: RepoWriteOutcomeDurabilityTestHooks;
}

export interface RepoWriteTerminalizeInputV1 extends RepoWriteOutcomeAxesV1 {
  readonly outerOpId: string;
  readonly requestDigest: string;
  readonly receipt: CommandReceiptEnvelope;
  readonly authorityEvidence: RepoWriteTerminalEvidenceV1;
}

export type RepoWriteOutcomeLookupV1 =
  | { readonly state: "not-found" }
  | {
      readonly state: "proceeding";
      readonly generation: "current";
      readonly outcome: RepoWriteProceedingOutcomeV1;
    }
  | {
      readonly state: "outcome-unknown";
      readonly generation: "historical";
      readonly observedPhase: "PROCEEDING";
      readonly recovery: "fenced-resume-required";
      readonly outcome: RepoWriteProceedingOutcomeV1;
    }
  | {
      readonly state: "terminal";
      readonly generation: "current" | "historical";
      readonly outcome: RepoWriteTerminalOutcomeV1;
    };

/**
 * Child-owned recovery index. A PROCEEDING file is published once, and a
 * TERMINAL successor is linked beside it. Neither durable file is replaced.
 */
export class DurableRepoWriteOutcomeStoreV1 {
  private readonly directory: string;
  private readonly axes: RepoWriteOutcomeAxesV1;
  private readonly durabilityHooks: RepoWriteOutcomeDurabilityTestHooks | undefined;

  constructor(options: DurableRepoWriteOutcomeStoreV1Options) {
    if (process.platform === "win32") throw new RepoWriteOutcomeUnsupportedPlatformError();
    this.directory = path.resolve(options.directory);
    this.durabilityHooks = options.__testOnlyDurabilityHooks;
    this.axes = {
      repoId: options.repoId,
      workspaceId: options.workspaceId,
      generation: options.generation
    };
    assertRepoWriteOutcomeAxesV1(
      createRepoWriteProceedingOutcomeV1({
        ...this.axes,
        outerOpId: "store-axis-check",
        innerOpId: "store-axis-check",
        authoritySemanticDigest: "0".repeat(64),
        canonicalCommand: { commandName: "store.axis.check", actor: {}, context: {}, payload: {} },
        authenticatedContext: { actor: {} },
        receiptSeed: repoWriteOutcomePlaceholderReceiptSeed(),
        recoveryContext: {}
      }),
      this.axes
    );
    repoWriteOutcomeEnsurePrivateDirectory(this.directory);
  }

  /**
   * Recovery lookup is intentionally cross-generation. Historical TERMINAL
   * receipts are replayable, while historical PROCEEDING stays honest-unknown
   * until a later activation stage supplies an explicit fenced-resume API.
   */
  lookup(outerOpId: string): RepoWriteOutcomeLookupV1 {
    const outcome = this.get(outerOpId);
    if (!outcome) return { state: "not-found" };
    const generation = outcome.generation === this.axes.generation ? "current" : "historical";
    if (outcome.phase === "TERMINAL") {
      return { state: "terminal", generation, outcome };
    }
    if (generation === "historical") {
      return {
        state: "outcome-unknown",
        generation,
        observedPhase: "PROCEEDING",
        recovery: "fenced-resume-required",
        outcome
      };
    }
    return { state: "proceeding", generation, outcome };
  }

  get(outerOpId: string): RepoWriteOutcomeV1 | undefined {
    const filePaths = repoWriteOutcomePaths(this.directory, outerOpId);
    const proceedingExists = repoWriteOutcomeDurablePathExists(filePaths.proceeding);
    const terminalExists = repoWriteOutcomeDurablePathExists(filePaths.terminal);
    if (!proceedingExists && !terminalExists) return undefined;
    if (!proceedingExists) {
      throw new RepoWriteOutcomeCorruptionError(
        `repo-write terminal outcome has no PROCEEDING predecessor: ${repoWriteOutcomeSafeIdentity(outerOpId)}`
      );
    }

    const proceeding = repoWriteOutcomeReadCanonical(filePaths.proceeding, this.durabilityHooks);
    if (proceeding.phase !== "PROCEEDING") {
      throw new RepoWriteOutcomeCorruptionError(
        `repo-write proceeding file has phase ${proceeding.phase}: ${repoWriteOutcomeSafeIdentity(outerOpId)}`
      );
    }
    this.assertIdentity(proceeding, outerOpId);
    if (!terminalExists) {
      this.observeExistingOutcome();
      return proceeding;
    }

    const terminal = repoWriteOutcomeReadCanonical(filePaths.terminal, this.durabilityHooks);
    if (terminal.phase !== "TERMINAL") {
      throw new RepoWriteOutcomeCorruptionError(
        `repo-write terminal file has phase ${terminal.phase}: ${repoWriteOutcomeSafeIdentity(outerOpId)}`
      );
    }
    this.assertIdentity(terminal, outerOpId);
    if (!sameRepoWriteOutcomeImmutableFieldsV1(proceeding, terminal)) {
      throw new RepoWriteOutcomeCorruptionError(
        `repo-write terminal outcome does not extend its PROCEEDING predecessor: ${repoWriteOutcomeSafeIdentity(outerOpId)}`
      );
    }
    this.observeExistingOutcome();
    return terminal;
  }

  begin(input: RepoWriteProceedingInputV1): RepoWriteOutcomeV1 {
    this.assertInputAxes(input);
    const candidate = createRepoWriteProceedingOutcomeV1(input);
    const current = this.get(input.outerOpId);
    if (current) return repoWriteOutcomeIdempotentBeginning(current, candidate);

    const published = repoWriteOutcomePublishOnce(
      this.directory,
      repoWriteOutcomePaths(this.directory, input.outerOpId).proceeding,
      canonicalRepoWriteOutcomeText(candidate),
      this.durabilityHooks
    );
    if (published) return candidate;
    const raced = this.get(input.outerOpId);
    if (!raced) {
      throw new RepoWriteOutcomeCorruptionError(
        `repo-write PROCEEDING publication disappeared: ${repoWriteOutcomeSafeIdentity(input.outerOpId)}`
      );
    }
    return repoWriteOutcomeIdempotentBeginning(raced, candidate);
  }

  terminalize(input: RepoWriteTerminalizeInputV1): RepoWriteTerminalOutcomeV1 {
    this.assertInputAxes(input);
    const current = this.get(input.outerOpId);
    if (!current) {
      throw new RepoWriteOutcomeConflictError(
        `cannot terminalize repo-write outcome before PROCEEDING: ${repoWriteOutcomeSafeIdentity(input.outerOpId)}`
      );
    }
    if (current.generation !== this.axes.generation) {
      throw new RepoWriteOutcomeConflictError(
        `historical-generation repo-write outcome requires fenced resume: ${repoWriteOutcomeSafeIdentity(input.outerOpId)}`
      );
    }
    if (current.requestDigest !== input.requestDigest) {
      throw new RepoWriteOutcomeConflictError(
        `outer opId is already bound to a different request digest: ${repoWriteOutcomeSafeIdentity(input.outerOpId)}`
      );
    }
    const proceeding = current.phase === "PROCEEDING"
      ? current
      : repoWriteOutcomeProceedingFromTerminal(current);
    const candidate = createRepoWriteTerminalOutcomeV1(
      proceeding,
      input.receipt,
      input.authorityEvidence
    );
    if (current.phase === "TERMINAL") return repoWriteOutcomeIdempotentTerminal(current, candidate);

    const published = repoWriteOutcomePublishOnce(
      this.directory,
      repoWriteOutcomePaths(this.directory, input.outerOpId).terminal,
      canonicalRepoWriteOutcomeText(candidate),
      this.durabilityHooks
    );
    if (published) return candidate;
    const raced = this.get(input.outerOpId);
    if (!raced || raced.phase !== "TERMINAL") {
      throw new RepoWriteOutcomeCorruptionError(
        `repo-write TERMINAL publication disappeared: ${repoWriteOutcomeSafeIdentity(input.outerOpId)}`
      );
    }
    return repoWriteOutcomeIdempotentTerminal(raced, candidate);
  }

  private assertInputAxes(input: RepoWriteOutcomeAxesV1): void {
    if (input.repoId !== this.axes.repoId
      || input.workspaceId !== this.axes.workspaceId
      || input.generation !== this.axes.generation) {
      throw new RepoWriteOutcomeConflictError(
        "repo-write outcome input does not match the store repo/workspace/generation axes"
      );
    }
  }

  private assertIdentity(outcome: RepoWriteOutcomeV1, outerOpId: string): void {
    if (outcome.repoId !== this.axes.repoId || outcome.workspaceId !== this.axes.workspaceId) {
      throw new RepoWriteOutcomeCorruptionError(
        `repo-write outcome repo/workspace identity does not match the writer capsule: ${repoWriteOutcomeSafeIdentity(outerOpId)}`
      );
    }
    if (outcome.outerOpId !== outerOpId) {
      throw new RepoWriteOutcomeCorruptionError(
        `repo-write outcome outer opId does not match its file identity: ${repoWriteOutcomeSafeIdentity(outerOpId)}`
      );
    }
    if (outcome.generation > this.axes.generation) {
      throw new RepoWriteOutcomeGenerationFenceError(
        `repo-write outcome belongs to a future writer generation: ${repoWriteOutcomeSafeIdentity(outerOpId)}`
      );
    }
  }

  private observeExistingOutcome(): void {
    repoWriteOutcomeFsyncDirectory(this.directory, this.durabilityHooks, "observe-existing");
  }
}

function repoWriteOutcomeIdempotentBeginning(
  current: RepoWriteOutcomeV1,
  candidate: RepoWriteProceedingOutcomeV1
): RepoWriteOutcomeV1 {
  if (current.requestDigest !== candidate.requestDigest) {
    throw new RepoWriteOutcomeConflictError(
      `outer opId is already bound to a different request digest: ${repoWriteOutcomeSafeIdentity(candidate.outerOpId)}`
    );
  }
  if (!sameRepoWriteOutcomeImmutableFieldsV1(current, candidate)) {
    throw new RepoWriteOutcomeConflictError(
      `outer opId immutable recovery fields do not match: ${repoWriteOutcomeSafeIdentity(candidate.outerOpId)}`
    );
  }
  return current;
}

function repoWriteOutcomeIdempotentTerminal(
  current: RepoWriteTerminalOutcomeV1,
  candidate: RepoWriteTerminalOutcomeV1
): RepoWriteTerminalOutcomeV1 {
  if (!sameRepoWriteOutcomeImmutableFieldsV1(current, candidate)
    || current.terminalKind !== candidate.terminalKind
    || current.receiptDigest !== candidate.receiptDigest
    || canonicalRepoWriteOutcomeText(current) !== canonicalRepoWriteOutcomeText(candidate)) {
    throw new RepoWriteOutcomeConflictError(
      `TERMINAL repo-write outcome is immutable: ${repoWriteOutcomeSafeIdentity(candidate.outerOpId)}`
    );
  }
  return current;
}

function repoWriteOutcomeProceedingFromTerminal(
  terminal: RepoWriteTerminalOutcomeV1
): RepoWriteProceedingOutcomeV1 {
  const {
    terminalKind: _terminalKind,
    terminalProof: _terminalProof,
    receipt: _receipt,
    receiptDigest: _receiptDigest,
    ...base
  } = terminal;
  return { ...base, phase: "PROCEEDING" };
}

function repoWriteOutcomeReadCanonical(
  file: string,
  hooks?: RepoWriteOutcomeDurabilityTestHooks
): RepoWriteOutcomeV1 {
  try {
    const descriptor = repoWriteOutcomeOpenPrivateRegularFile(file);
    try {
      const text = readFileSync(descriptor, "utf8");
      const parsed = decodeRepoWriteOutcomeV1(JSON.parse(text) as unknown);
      if (text !== canonicalRepoWriteOutcomeText(parsed)) {
        throw new RepoWriteOutcomeCorruptionError(`repo-write outcome is not canonically encoded: ${path.basename(file)}`);
      }
      repoWriteOutcomeFsyncOpened(descriptor, file, hooks, "observe-existing");
      return parsed;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof RepoWriteOutcomeCorruptionError) throw error;
    throw new RepoWriteOutcomeCorruptionError(
      `cannot read durable repo-write outcome: ${path.basename(file)}`,
      { cause: error }
    );
  }
}

function repoWriteOutcomePublishOnce(
  directory: string,
  target: string,
  text: string,
  hooks?: RepoWriteOutcomeDurabilityTestHooks
): boolean {
  if (Buffer.byteLength(text, "utf8") > maximumOutcomeBytes) {
    throw new RepoWriteOutcomeValidationError(
      `repo-write outcome exceeds the ${maximumOutcomeBytes}-byte durable record limit`
    );
  }
  repoWriteOutcomeEnsurePrivateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    if (process.platform !== "win32" && (fstatSync(descriptor).mode & 0o777) !== 0o600) {
      throw new RepoWriteOutcomeCorruptionError("repo-write temporary outcome must have mode 0600");
    }
    writeFileSync(descriptor, text, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    hooks?.beforePublishLink?.({ target, text });
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (repoWriteOutcomeIsAlreadyExists(error)) {
        repoWriteOutcomeFsyncExisting(target, hooks, "eexist-observer");
        repoWriteOutcomeFsyncDirectory(directory, hooks, "eexist-observer");
        return false;
      }
      throw error;
    }
    repoWriteOutcomeFsyncDirectory(directory, hooks, "publish");
    return true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function repoWriteOutcomeFsyncExisting(
  file: string,
  hooks: RepoWriteOutcomeDurabilityTestHooks | undefined,
  reason: TargetFsyncReason
): void {
  const descriptor = repoWriteOutcomeOpenPrivateRegularFile(file);
  try {
    repoWriteOutcomeFsyncOpened(descriptor, file, hooks, reason);
  } finally {
    closeSync(descriptor);
  }
}

function repoWriteOutcomeFsyncOpened(
  descriptor: number,
  file: string,
  hooks: RepoWriteOutcomeDurabilityTestHooks | undefined,
  reason: TargetFsyncReason
): void {
  fsyncSync(descriptor);
  hooks?.afterTargetFsync?.({ reason, target: file });
}

function repoWriteOutcomeEnsurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const status = lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new RepoWriteOutcomeCorruptionError("repo-write outcome root must be a real directory");
  }
  if (process.platform !== "win32") {
    chmodSync(directory, 0o700);
    if ((lstatSync(directory).mode & 0o777) !== 0o700) {
      throw new RepoWriteOutcomeCorruptionError("repo-write outcome root must have mode 0700");
    }
  }
}

function repoWriteOutcomeOpenPrivateRegularFile(file: string): number {
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const status = fstatSync(descriptor);
  if (!status.isFile()) {
    closeSync(descriptor);
    throw new RepoWriteOutcomeCorruptionError(`repo-write outcome is not a regular file: ${path.basename(file)}`);
  }
  if (status.size <= 0 || status.size > maximumOutcomeBytes) {
    closeSync(descriptor);
    throw new RepoWriteOutcomeCorruptionError(
      `repo-write outcome has an invalid byte length: ${path.basename(file)}`
    );
  }
  if (process.platform !== "win32" && (status.mode & 0o777) !== 0o600) {
    closeSync(descriptor);
    throw new RepoWriteOutcomeCorruptionError(`repo-write outcome must have mode 0600: ${path.basename(file)}`);
  }
  return descriptor;
}

function repoWriteOutcomeFsyncDirectory(
  directory: string,
  hooks: RepoWriteOutcomeDurabilityTestHooks | undefined,
  reason: DirectoryFsyncReason
): void {
  if (process.platform === "win32") throw new RepoWriteOutcomeUnsupportedPlatformError();
  hooks?.beforeDirectoryFsync?.(reason);
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function repoWriteOutcomePaths(directory: string, outerOpId: string): {
  readonly proceeding: string;
  readonly terminal: string;
} {
  const normalized = createRepoWriteProceedingOutcomeV1({
    repoId: "path-check",
    workspaceId: "path-check",
    generation: 1,
    outerOpId,
    innerOpId: "path-check",
    authoritySemanticDigest: "0".repeat(64),
    canonicalCommand: { commandName: "path.check", actor: {}, context: {}, payload: {} },
    authenticatedContext: { actor: {} },
    receiptSeed: repoWriteOutcomePlaceholderReceiptSeed(),
    recoveryContext: {}
  });
  const key = sha256Text(normalized.outerOpId);
  const prefix = path.join(directory, `repo-write-outcome-v1.${key}`);
  return {
    proceeding: `${prefix}${proceedingSuffix}`,
    terminal: `${prefix}${terminalSuffix}`
  };
}

function repoWriteOutcomeIsAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function repoWriteOutcomeDurablePathExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function repoWriteOutcomeSafeIdentity(value: string): string {
  return sha256Text(value).slice(0, 12);
}

function repoWriteOutcomePlaceholderReceiptSeed() {
  return {
    schema: repoWriteReceiptSeedSchema,
    renderer: "cli-command-receipt/v2@1" as const,
    generatedAt: "1970-01-01T00:00:00.000Z",
    command: "store check",
    action: "check",
    actorStampDigest: repoWriteActorStampDigestV1({})
  };
}
