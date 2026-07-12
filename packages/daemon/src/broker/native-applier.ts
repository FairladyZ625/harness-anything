import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { BrokerCasStore } from "./cas-store.ts";
import { atomicWrite, syncDirectory } from "./durable-state-store.ts";
import { fingerprintDigest, fingerprintPath, sameFingerprint } from "./fingerprint.ts";
import type { BrokerCrashInjector, BrokerVersion, ManagedFingerprint } from "./types.ts";
import { isMissing } from "./errno.ts";

type ApplyPhase =
  | "INTENT_DURABLE"
  | "PRECHECK_VERIFIED_DURABLE"
  | "STAGED_DURABLE"
  | "NAMESPACE_MUTATED_DURABLE"
  | "GENERATION_RETAINED_DURABLE"
  | "POST_VERIFIED_DURABLE"
  | "RESOLVED_DURABLE";

interface ApplyJournal {
  readonly schema: "broker-apply/v1";
  readonly applyId: string;
  readonly path: string;
  readonly operation: "replace" | "create" | "delete";
  readonly expectedBaseFingerprint: ManagedFingerprint;
  readonly target: BrokerVersion;
  readonly shortTempName: string;
  readonly guardName: string;
  readonly phase: ApplyPhase;
}

export type NativeApplyResult =
  | { readonly tag: "APPLIED"; readonly fingerprint: ManagedFingerprint; readonly applyId: string }
  | { readonly tag: "CONFLICT"; readonly observed: ManagedFingerprint; readonly applyId: string; readonly reason: string }
  | { readonly tag: "BLOCKED"; readonly applyId: string; readonly reason: string };

export class CrashSafeNativeApplier {
  private readonly viewRoot: string;
  private readonly stateRoot: string;
  private readonly cas: BrokerCasStore;
  private readonly crashInjector: BrokerCrashInjector | undefined;

  constructor(options: {
    readonly viewRoot: string;
    readonly stateRoot: string;
    readonly cas: BrokerCasStore;
    readonly crashInjector?: BrokerCrashInjector;
  }) {
    this.viewRoot = options.viewRoot;
    this.stateRoot = options.stateRoot;
    this.cas = options.cas;
    this.crashInjector = options.crashInjector;
  }

  async apply(pathName: string, expected: ManagedFingerprint, target: BrokerVersion): Promise<NativeApplyResult> {
    const applyId = fingerprintDigest({ pathName, expected, target }).replace(/^sha256:/u, "").slice(0, 24);
    const existing = await this.loadJournal(applyId);
    if (existing) return this.recover(existing);
    const destination = this.destination(pathName);
    const operation = target.fingerprint.objectKind === "tombstone"
      ? "delete"
      : expected.objectKind === "tombstone" ? "create" : "replace";
    const journal: ApplyJournal = {
      schema: "broker-apply/v1",
      applyId,
      path: pathName,
      operation,
      expectedBaseFingerprint: expected,
      target,
      shortTempName: `.ha-${applyId.slice(0, 12)}.stage`,
      guardName: `${applyId}.guard`,
      phase: "INTENT_DURABLE"
    };
    await this.saveJournal(journal);
    await this.crashInjector?.hit("after_intent", pathName);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const observed = await fingerprintPath(destination);
    if (!sameFingerprint(observed, expected)) {
      return { tag: "CONFLICT", observed, applyId, reason: "PRECHECK_FINGERPRINT_MISMATCH" };
    }
    const prechecked = await this.advance(journal, "PRECHECK_VERIFIED_DURABLE");
    if (operation === "delete") return this.mutate(prechecked);
    const staged = path.join(path.dirname(destination), journal.shortTempName);
    const bytes = await this.cas.get(target.fingerprint.blobDigest);
    await atomicWrite(staged, bytes);
    await chmod(staged, target.fingerprint.logicalMode);
    await syncFile(staged);
    const stagedFingerprint = await fingerprintPath(staged);
    if (!sameFingerprint(stagedFingerprint, target.fingerprint)) {
      return { tag: "BLOCKED", applyId, reason: "STAGED_FINGERPRINT_MISMATCH" };
    }
    const stagedDurable = await this.advance(prechecked, "STAGED_DURABLE");
    await this.crashInjector?.hit("after_stage", pathName);
    return this.mutate(stagedDurable);
  }

  async markResolved(applyId: string): Promise<void> {
    const journal = await this.loadJournal(applyId);
    if (!journal || journal.phase === "RESOLVED_DURABLE") return;
    if (journal.phase !== "POST_VERIFIED_DURABLE" && journal.phase !== "GENERATION_RETAINED_DURABLE") {
      throw new Error(`cannot resolve apply ${applyId} from ${journal.phase}`);
    }
    await this.advance(journal, "RESOLVED_DURABLE");
    await this.crashInjector?.hit("after_apply_resolved", journal.path);
  }

  private async recover(journal: ApplyJournal): Promise<NativeApplyResult> {
    if (journal.phase === "RESOLVED_DURABLE" || journal.phase === "POST_VERIFIED_DURABLE"
      || journal.phase === "GENERATION_RETAINED_DURABLE" || journal.phase === "NAMESPACE_MUTATED_DURABLE") {
      return this.verifyAndFinish(journal);
    }
    const destination = this.destination(journal.path);
    const staged = path.join(path.dirname(destination), journal.shortTempName);
    const guard = this.guardPath(journal.guardName);
    const [destinationFingerprint, stagedFingerprint, guardFingerprint] = await Promise.all([
      fingerprintPath(destination), fingerprintPath(staged), fingerprintPath(guard)
    ]);
    const destinationIsTarget = sameFingerprint(destinationFingerprint, journal.target.fingerprint);
    const destinationIsOld = sameFingerprint(destinationFingerprint, journal.expectedBaseFingerprint);
    const stageIsTarget = sameFingerprint(stagedFingerprint, journal.target.fingerprint);
    const guardIsOld = sameFingerprint(guardFingerprint, journal.expectedBaseFingerprint);

    if (journal.phase === "INTENT_DURABLE" && destinationIsOld
      && guardFingerprint.objectKind === "tombstone") {
      const prechecked = await this.advance(journal, "PRECHECK_VERIFIED_DURABLE");
      if (journal.operation === "delete") return this.mutate(prechecked);
      const bytes = await this.cas.get(journal.target.fingerprint.blobDigest);
      await atomicWrite(staged, bytes);
      await chmod(staged, journal.target.fingerprint.logicalMode);
      await syncFile(staged);
      const restaged = await fingerprintPath(staged);
      if (!sameFingerprint(restaged, journal.target.fingerprint)) {
        return { tag: "BLOCKED", applyId: journal.applyId, reason: "RECOVERY_STAGE_FINGERPRINT_MISMATCH" };
      }
      return this.mutate(await this.advance(prechecked, "STAGED_DURABLE"));
    }

    if (destinationIsTarget && (guardIsOld || journal.expectedBaseFingerprint.objectKind === "tombstone")) {
      return this.verifyAndFinish(await this.advance(journal, "NAMESPACE_MUTATED_DURABLE"));
    }
    if (journal.operation === "delete") {
      if (destinationFingerprint.objectKind === "tombstone" && guardIsOld) {
        return this.verifyAndFinish(await this.advance(journal, "NAMESPACE_MUTATED_DURABLE"));
      }
      if (destinationIsOld && guardFingerprint.objectKind === "tombstone") return this.mutate(journal);
    } else {
      if (destinationFingerprint.objectKind === "tombstone" && guardIsOld && stageIsTarget) {
        await rename(staged, destination);
        await syncDirectory(path.dirname(destination));
        return this.verifyAndFinish(await this.advance(journal, "NAMESPACE_MUTATED_DURABLE"));
      }
      if (destinationIsOld && stageIsTarget && guardFingerprint.objectKind === "tombstone") {
        return this.mutate(journal);
      }
    }
    return { tag: "CONFLICT", observed: destinationFingerprint, applyId: journal.applyId, reason: "RECOVERY_GENERATION_AMBIGUOUS" };
  }

  private async mutate(journal: ApplyJournal): Promise<NativeApplyResult> {
    const destination = this.destination(journal.path);
    const staged = path.join(path.dirname(destination), journal.shortTempName);
    const guard = this.guardPath(journal.guardName);
    await mkdir(path.dirname(guard), { recursive: true, mode: 0o700 });
    const current = await fingerprintPath(destination);
    if (current.objectKind === "file") {
      await rename(destination, guard);
      await Promise.all([syncDirectory(path.dirname(destination)), syncDirectory(path.dirname(guard))]);
      await this.crashInjector?.hit("after_old_retained", journal.path);
    }
    if (journal.operation !== "delete") {
      await rename(staged, destination);
      await syncDirectory(path.dirname(destination));
    }
    const mutated = await this.advance(journal, "NAMESPACE_MUTATED_DURABLE");
    await this.crashInjector?.hit("after_namespace_mutation", journal.path);
    return this.verifyAndFinish(mutated);
  }

  private async verifyAndFinish(journal: ApplyJournal): Promise<NativeApplyResult> {
    const observed = await fingerprintPath(this.destination(journal.path));
    if (!sameFingerprint(observed, journal.target.fingerprint)) {
      return { tag: "CONFLICT", observed, applyId: journal.applyId, reason: "POST_VERIFY_FINGERPRINT_MISMATCH" };
    }
    let current = journal;
    if (phaseBefore(current.phase, "GENERATION_RETAINED_DURABLE")) {
      current = await this.advance(current, "GENERATION_RETAINED_DURABLE");
    }
    if (phaseBefore(current.phase, "POST_VERIFIED_DURABLE")) {
      current = await this.advance(current, "POST_VERIFIED_DURABLE");
      await this.crashInjector?.hit("after_post_verify", journal.path);
    }
    return { tag: "APPLIED", fingerprint: observed, applyId: current.applyId };
  }

  private async advance(journal: ApplyJournal, phase: ApplyPhase): Promise<ApplyJournal> {
    const next = { ...journal, phase };
    await this.saveJournal(next);
    return next;
  }

  private async saveJournal(journal: ApplyJournal): Promise<void> {
    await atomicWrite(this.journalPath(journal.applyId), Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"));
  }

  private async loadJournal(applyId: string): Promise<ApplyJournal | undefined> {
    try {
      const journal = JSON.parse(await readFile(this.journalPath(applyId), "utf8")) as ApplyJournal;
      if (journal.schema !== "broker-apply/v1" || journal.applyId !== applyId) throw new Error("invalid apply journal");
      return journal;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private destination(pathName: string): string {
    return path.join(this.viewRoot, ...pathName.split("/"));
  }

  private guardPath(name: string): string {
    return path.join(this.stateRoot, "displaced-guards", name);
  }

  private journalPath(applyId: string): string {
    return path.join(this.stateRoot, "db-and-wal", "applies", `${applyId}.json`);
  }
}

const phases: ReadonlyArray<ApplyPhase> = [
  "INTENT_DURABLE",
  "PRECHECK_VERIFIED_DURABLE",
  "STAGED_DURABLE",
  "NAMESPACE_MUTATED_DURABLE",
  "GENERATION_RETAINED_DURABLE",
  "POST_VERIFIED_DURABLE",
  "RESOLVED_DURABLE"
];

function phaseBefore(left: ApplyPhase, right: ApplyPhase): boolean {
  return phases.indexOf(left) < phases.indexOf(right);
}


async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
