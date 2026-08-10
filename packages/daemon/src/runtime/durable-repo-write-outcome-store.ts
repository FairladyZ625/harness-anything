import { closeSync, readdirSync } from "node:fs";
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
  sameRepoWriteOutcomeImmutableFieldsV1,
  type RepoWriteOutcomeAxesV1,
  type RepoWriteOutcomeV1,
  type RepoWriteProceedingInputV1,
  type RepoWriteProceedingOutcomeV1,
  type RepoWriteTerminalEvidenceV1,
  type RepoWriteTerminalOutcomeV1
} from "./repo-write-outcome-schema.ts";
import {
  repoWriteOutcomeDurablePathExists,
  repoWriteOutcomeEnsurePrivateDirectory,
  repoWriteOutcomeFsyncDirectory,
  repoWriteOutcomeFsyncOpened,
  repoWriteOutcomePublishOnce,
  repoWriteOutcomeReadPrivateText,
  type RepoWriteOutcomeDurabilityTestHooks
} from "./repo-write-outcome-durable-file.ts";
import {
  repoWriteHistoricalRecoveryRejectionRead,
  repoWriteHistoricalRecoveryReject,
  type RepoWriteHistoricalRecoveryRejectionV1,
  type RepoWriteHistoricalRecoveryRejectInputV1
} from "./repo-write-historical-recovery-rejection.ts";
import type { RepoWriteCommandDto } from "./repo-write-protocol.ts";
import {
  RepoWriteOutcomeConflictError,
  RepoWriteOutcomeCorruptionError,
  RepoWriteOutcomeGenerationFenceError,
  RepoWriteOutcomeUnsupportedPlatformError
} from "./repo-write-outcome-errors.ts";

export {
  RepoWriteOutcomeConflictError,
  RepoWriteOutcomeCorruptionError,
  RepoWriteOutcomeGenerationFenceError,
  RepoWriteOutcomeUnsupportedPlatformError
} from "./repo-write-outcome-errors.ts";
export type { RepoWriteOutcomeDurabilityTestHooks } from "./repo-write-outcome-durable-file.ts";
export type {
  RepoWriteHistoricalRecoveryRejectionV1,
  RepoWriteHistoricalRecoveryRejectInputV1
} from "./repo-write-historical-recovery-rejection.ts";

const proceedingSuffix = ".proceeding.json";
const terminalSuffix = ".terminal.json";
const historicalRecoveryRejectionSuffix = ".recovery-rejected.json";

export interface DurableRepoWriteOutcomeStoreV1Options extends RepoWriteOutcomeAxesV1 {
  readonly directory: string;
  readonly __testOnlyDurabilityHooks?: RepoWriteOutcomeDurabilityTestHooks;
}

export interface RepoWriteTerminalizeInputV1 extends RepoWriteOutcomeAxesV1 {
  readonly outerOpId: string;
  readonly requestDigest: string;
  readonly receipt: CommandReceiptEnvelope;
  readonly authorityEvidence: RepoWriteTerminalEvidenceV1;
  readonly historicalPublicationCommitSha?: string;
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
        canonicalCommand: repoWriteOutcomePlaceholderCommand(),
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

  listHistoricalProceedings(): ReadonlyArray<RepoWriteProceedingOutcomeV1> {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(proceedingSuffix))
      .sort()
      .flatMap((name) => {
        const proceeding = repoWriteOutcomeReadCanonical(
          path.join(this.directory, name),
          this.durabilityHooks
        );
        if (proceeding.phase !== "PROCEEDING") {
          throw new RepoWriteOutcomeCorruptionError(
            `repo-write proceeding file has phase ${proceeding.phase}: ${name}`
          );
        }
        this.assertIdentity(proceeding, proceeding.outerOpId);
        const current = this.get(proceeding.outerOpId);
        return current?.phase === "PROCEEDING"
          && current.generation < this.axes.generation
          && !this.usableHistoricalRecoveryRejection(current)
          ? [current]
          : [];
      });
  }

  getHistoricalRecoveryRejection(
    outerOpId: string
  ): RepoWriteHistoricalRecoveryRejectionV1 | undefined {
    return repoWriteHistoricalRecoveryRejectionRead({
      directory: this.directory,
      file: repoWriteOutcomePaths(this.directory, outerOpId).historicalRecoveryRejection,
      axes: this.axes,
      current: this.get(outerOpId),
      ...(this.durabilityHooks ? { hooks: this.durabilityHooks } : {})
    });
  }

  rejectHistoricalRecovery(
    input: RepoWriteHistoricalRecoveryRejectInputV1
  ): RepoWriteHistoricalRecoveryRejectionV1 {
    this.assertInputAxes(input);
    return repoWriteHistoricalRecoveryReject({
      directory: this.directory,
      file: repoWriteOutcomePaths(this.directory, input.outerOpId).historicalRecoveryRejection,
      axes: this.axes,
      current: this.get(input.outerOpId),
      requestDigest: input.requestDigest,
      code: input.code,
      ...(this.durabilityHooks ? { hooks: this.durabilityHooks } : {})
    });
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
    const historicalPublication = input.historicalPublicationCommitSha;
    const committedEvidence = input.authorityEvidence.tag === "COMMITTED"
      || input.authorityEvidence.tag === "CANONICAL_PUBLICATION";
    if (current.generation !== this.axes.generation
      && (current.generation >= this.axes.generation
        || !committedEvidence
        || input.authorityEvidence.commitSha !== historicalPublication)) {
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
    if (published) {
      const durable = this.get(input.outerOpId);
      if (!durable || durable.phase !== "TERMINAL") {
        throw new RepoWriteOutcomeCorruptionError(
          `repo-write TERMINAL publication disappeared: ${repoWriteOutcomeSafeIdentity(input.outerOpId)}`
        );
      }
      return durable;
    }
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

  private usableHistoricalRecoveryRejection(
    current: RepoWriteOutcomeV1
  ): RepoWriteHistoricalRecoveryRejectionV1 | undefined {
    try {
      return repoWriteHistoricalRecoveryRejectionRead({
        directory: this.directory,
        file: repoWriteOutcomePaths(
          this.directory,
          current.outerOpId
        ).historicalRecoveryRejection,
        axes: this.axes,
        current,
        ...(this.durabilityHooks ? { hooks: this.durabilityHooks } : {})
      });
    } catch (error) {
      if (error instanceof RepoWriteOutcomeCorruptionError) return undefined;
      throw error;
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
    const { descriptor, text } = repoWriteOutcomeReadPrivateText(file);
    try {
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

function repoWriteOutcomePaths(directory: string, outerOpId: string): {
  readonly proceeding: string;
  readonly terminal: string;
  readonly historicalRecoveryRejection: string;
} {
  const normalized = createRepoWriteProceedingOutcomeV1({
    repoId: "path-check",
    workspaceId: "path-check",
    generation: 1,
    outerOpId,
    innerOpId: "path-check",
    authoritySemanticDigest: "0".repeat(64),
    canonicalCommand: repoWriteOutcomePlaceholderCommand(),
    authenticatedContext: { actor: {} },
    receiptSeed: repoWriteOutcomePlaceholderReceiptSeed(),
    recoveryContext: {}
  });
  const key = sha256Text(normalized.outerOpId);
  const prefix = path.join(directory, `repo-write-outcome-v1.${key}`);
  return {
    proceeding: `${prefix}${proceedingSuffix}`,
    terminal: `${prefix}${terminalSuffix}`,
    historicalRecoveryRejection: `${prefix}${historicalRecoveryRejectionSuffix}`
  };
}

function repoWriteOutcomeSafeIdentity(value: string): string {
  return sha256Text(value).slice(0, 12);
}

function repoWriteOutcomePlaceholderCommand(): RepoWriteCommandDto {
  return {
    commandName: "gui",
    actor: {},
    context: {},
    payload: {
      command: { rootDir: "/repo-write-outcome-placeholder", json: true, action: { kind: "gui" } },
      session: {
        runtime: "human",
        sessionId: "repo-write-outcome-placeholder",
        source: "manual",
        detectedAt: "1970-01-01T00:00:00.000Z"
      }
    }
  };
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
