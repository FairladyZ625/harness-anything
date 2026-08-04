import type { VersionControlSystem } from "../../ports/version-control-system.ts";
import type { WriteOp } from "../../ports/write-coordinator.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../layout/index.ts";
import { makeLocalVersionControlSystem } from "../../persistence/git/local-version-control-system.ts";
import { assertDocumentWritePathsDoNotCollide } from "../../persistence/markdown/markdown-artifact-store.ts";
import { rejectWrite } from "./rejection.ts";
import { assertCodeDocGitEvidence } from "./operations/code-doc-policy.ts";
import {
  documentWritesForWriteValidation,
  validateWriteTransaction,
  writeOpTouchedPaths
} from "./operations/transaction-plan.ts";
import { assertCommitPlanAddable } from "./publication/git.ts";

export function preflightWriteOp(
  rootDir: string,
  rootInput: HarnessLayoutInput,
  op: WriteOp,
  versionControlSystem?: VersionControlSystem
): void {
  const vcs = versionControlSystem ?? makeLocalVersionControlSystem();
  assertCommitPlanAddable(rootDir, writeOpTouchedPaths(rootInput, op), rootInput, { versionControlSystem: vcs });
  const documentWrites = documentWritesForWriteValidation(rootInput, op);
  assertCodeDocGitEvidence(rootDir, resolveHarnessLayout(rootInput).authoredRoot, op, documentWrites, vcs);
  try {
    assertDocumentWritePathsDoNotCollide(rootInput, documentWrites);
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error), op.entityId);
  }
}

export function validateWriteOp(rootInput: HarnessLayoutInput, op: WriteOp): void {
  if (op.opId.length === 0) rejectWrite("opId is required", op.entityId);
  if (op.entityId.length === 0) rejectWrite("entityId is required", op.entityId);
  validateWriteTransaction(rootInput, op);
}
