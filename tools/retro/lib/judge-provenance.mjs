/**
 * Tamper-resistant judge & holdout provenance verifier anchored to `origin/main`.
 *
 * Implements dec_D8EECF29C93D0C300252060A10/CH2 & CH3:
 * - Resolves `originMainSha` and `targetCommitSha` via `tools/readonly-checkout.mjs`.
 * - Fails closed (exit code 2) whenever `origin/main` (or the requested origin ref) is unreachable.
 * - Reads the judge closure files and (when present on `origin/main`) the `holdout` dataset directly
 *   from `origin/main` via `showPath()`, recording SHA-256 digests (`harnessClosureSha256`, `casesSha256`)
 *   and flagging any local working-tree tampering of `origin/main`-anchored files.
 */
import { hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveRevision, showPath } from "../../readonly-checkout.mjs";

export const RETRO_PROVENANCE_SCHEMA = "retro-judge-provenance/v1";
export const DEFAULT_ORIGIN_REF = "origin/main";
const FAIL_CLOSED_EXIT_CODE = 2;

export const JUDGE_CLOSURE_PATHS = Object.freeze([
  "tools/evals/closeout-reviewer/run-eval.mjs",
  "tools/evals/closeout-reviewer/unified-diff.mjs",
  "tools/retro/lib/schemas.mjs",
  "tools/retro/lib/sanitize.mjs",
  "tools/retro/lib/judge-provenance.mjs",
  "tools/retro/eval.mjs",
]);

export class ProvenanceError extends Error {
  constructor(message, code = "provenance_failed", exitCode = FAIL_CLOSED_EXIT_CODE) {
    super(message);
    this.name = "ProvenanceError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Deterministic SHA-256 hex digest of a UTF-8 string or Buffer. */
export function sha256Hex(content) {
  return hash("sha256", content, "hex");
}

function toPosixRelative(rootDir, targetPath) {
  const absRoot = path.resolve(rootDir);
  const absTarget = path.resolve(targetPath);
  const rel = path.relative(absRoot, absTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * Verify `origin/main` reachability, compute `harnessClosureSha256` from `origin/main`
 * (and detect any local drift against `origin/main` closure files), and load/fingerprint
 * the evaluation cases dataset (reading from `origin/main` when evaluating a holdout dataset
 * committed on `origin/main`).
 */
export function verifyJudgeProvenance(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const originRef = options.originRef ?? DEFAULT_ORIGIN_REF;
  const targetRef = options.targetRef ?? "HEAD";
  const closurePaths = options.closurePaths ?? JUDGE_CLOSURE_PATHS;
  const casesPath = options.casesPath ? path.resolve(options.casesPath) : null;
  const requireOriginCases = options.requireOriginCases === true;
  const strictJudgeClosure = options.strictJudgeClosure === true;

  const originResolved = resolveRevision(rootDir, originRef);
  if (!originResolved.ok) {
    throw new ProvenanceError(
      `Fail-closed: ${originRef} is unreachable (${originResolved.detail})`,
      "origin_main_unreachable",
      FAIL_CLOSED_EXIT_CODE,
    );
  }
  const originMainSha = originResolved.commit;

  const targetResolved = resolveRevision(rootDir, targetRef);
  if (!targetResolved.ok) {
    throw new ProvenanceError(
      `Fail-closed: target revision ${targetRef} is unresolvable (${targetResolved.detail})`,
      "target_commit_unresolvable",
      FAIL_CLOSED_EXIT_CODE,
    );
  }
  const targetCommitSha = targetResolved.commit;

  const originMainFiles = [];
  const localOnlyFiles = [];
  const divergedJudgeFiles = [];
  const closureDigestParts = [];

  for (const relPath of [...closurePaths].sort()) {
    const fromOrigin = showPath(rootDir, originMainSha, relPath);
    const localAbs = path.join(rootDir, relPath);
    const localExists = existsSync(localAbs);
    const localBody = localExists ? readFileSync(localAbs, "utf8") : null;

    if (fromOrigin.ok) {
      const originHash = sha256Hex(fromOrigin.body);
      originMainFiles.push(relPath);
      closureDigestParts.push(`origin:${relPath}:${originHash}`);
      if (localBody !== null && sha256Hex(localBody) !== originHash) {
        divergedJudgeFiles.push(relPath);
      }
    } else if (localBody !== null) {
      const localHash = sha256Hex(localBody);
      localOnlyFiles.push(relPath);
      closureDigestParts.push(`local:${relPath}:${localHash}`);
    }
  }

  if (originMainFiles.length === 0) {
    throw new ProvenanceError(
      `Fail-closed: none of the judge closure files exist at ${originRef} (${originMainSha})`,
      "origin_closure_empty",
      FAIL_CLOSED_EXIT_CODE,
    );
  }

  if (strictJudgeClosure && divergedJudgeFiles.length > 0) {
    throw new ProvenanceError(
      `Fail-closed: local judge closure files diverge from ${originRef}: ${divergedJudgeFiles.join(", ")}`,
      "judge_closure_tampered",
      FAIL_CLOSED_EXIT_CODE,
    );
  }

  const harnessClosureSha256 = sha256Hex(closureDigestParts.join("\n"));

  let casesRawText = null;
  let casesSha256 = null;
  let casesSource = "none";
  let casesLogicalPath = null;
  let holdoutDivergedFromOrigin = false;

  if (casesPath !== null) {
    const relCasesPath = toPosixRelative(rootDir, casesPath);
    casesLogicalPath = relCasesPath ?? path.basename(casesPath);
    const fromOriginCases = relCasesPath ? showPath(rootDir, originMainSha, relCasesPath) : { ok: false };
    const localCasesExists = existsSync(casesPath);
    const localCasesBody = localCasesExists ? readFileSync(casesPath, "utf8") : null;

    const targetsHoldout =
      relCasesPath === "tools/retro/datasets/holdout.json" ||
      (relCasesPath !== null && relCasesPath.endsWith("/holdout.json"));

    if (fromOriginCases.ok && (targetsHoldout || requireOriginCases)) {
      casesRawText = fromOriginCases.body;
      casesSha256 = sha256Hex(casesRawText);
      casesSource = originRef;
      if (localCasesBody !== null && sha256Hex(localCasesBody) !== casesSha256) {
        holdoutDivergedFromOrigin = true;
      }
    } else if (requireOriginCases) {
      throw new ProvenanceError(
        `Fail-closed: cases file ${relCasesPath ?? casesPath} is not present at ${originRef} (${originMainSha})`,
        "origin_cases_unreachable",
        FAIL_CLOSED_EXIT_CODE,
      );
    } else if (localCasesBody !== null) {
      casesRawText = localCasesBody;
      casesSha256 = sha256Hex(casesRawText);
      casesSource = fromOriginCases.ok ? "local-non-holdout" : "local-pre-merge";
    } else {
      throw new ProvenanceError(
        `Fail-closed: cases file not found: ${casesPath}`,
        "cases_file_missing",
        FAIL_CLOSED_EXIT_CODE,
      );
    }
  }

  return {
    provenance: {
      schema: RETRO_PROVENANCE_SCHEMA,
      originRef,
      originMainSha,
      targetCommitSha,
      harnessClosureSha256,
      casesSha256,
      casesSource,
      casesLogicalPath,
      originMainClosureFiles: originMainFiles,
      localOnlyClosureFiles: localOnlyFiles,
      divergedJudgeFiles,
      holdoutDivergedFromOrigin,
    },
    casesRawText,
  };
}
