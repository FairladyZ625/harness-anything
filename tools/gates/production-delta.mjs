import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { git, pathExistsAt, repoRoot } from "./git.mjs";
import { isMergifyQueueDraft } from "./mergify-queue-draft.mjs";
import { classifyModule, isProductionPath, normalizeRepoPath } from "./module-policy.mjs";
import { loadReceipts, verifyReceipt } from "./receipt-verify.mjs";
import { writeCiGateResult } from "../ci-gate-result.mjs";

const DELTA_LINE = /^Production-Delta:[ \t]*\+(\d+)\s*\/\s*-(\d+)\s*$/gmu;
const RETAINED_LINE = /^Retained-Path:[ \t]*(\S+)\s+until\s+(\d{4}-\d{2}-\d{2})\s+per\s+(dec_[0-9A-Za-z]+)\s*$/gmu;

// The declared delta describes the branch, so it is measured from the merge-base with the
// target ref rather than from the target's tip: main advancing under an open PR must not
// change a number the author already verified (2026-08-27: six body edits on one PR).
export function resolveDeltaBase(rootDir, base) {
  return git(rootDir, ["merge-base", base, "HEAD"]).trim() || base;
}

export function computeProductionDelta({ rootDir, base }) {
  const output = git(rootDir, ["diff", "--no-renames", "--numstat", "-z", resolveDeltaBase(rootDir, base), "--"]);
  const changed = [];
  const unclassified = [];
  let added = 0;
  let deleted = 0;

  for (const record of output.split("\0").filter(Boolean)) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error("git produced an invalid numstat record");
    const addedText = record.slice(0, firstTab);
    const deletedText = record.slice(firstTab + 1, secondTab);
    const filePath = record.slice(secondTab + 1);
    if (!isProductionPath(filePath)) continue;
    const moduleName = classifyModule(filePath);
    if (moduleName === null) {
      unclassified.push(filePath);
      continue;
    }
    if (addedText === "-" || deletedText === "-") throw new Error(`production source must be text: ${filePath}`);
    const fileAdded = Number.parseInt(addedText, 10);
    const fileDeleted = Number.parseInt(deletedText, 10);
    added += fileAdded;
    deleted += fileDeleted;
    changed.push({ filePath, module: moduleName, added: fileAdded, deleted: fileDeleted });
  }

  return { added, deleted, changed, unclassified };
}

export function parseProductionDeclaration(prBody) {
  const matches = [...prBody.matchAll(DELTA_LINE)];
  if (matches.length !== 1) {
    return {
      declaration: null,
      errors: [`PR body must contain exactly one Production-Delta: +N/-M line; found ${matches.length}`],
    };
  }
  return {
    declaration: { added: Number.parseInt(matches[0][1], 10), deleted: Number.parseInt(matches[0][2], 10) },
    errors: [],
  };
}

export function parseRetainedPaths(prBody) {
  const declarations = [...prBody.matchAll(RETAINED_LINE)].map((match) => ({
    path: match[1],
    until: match[2],
    decisionId: match[3],
  }));
  const retainedLines = prBody.split(/\r?\n/u).filter((line) => line.startsWith("Retained-Path:"));
  const errors =
    retainedLines.length === declarations.length
      ? []
      : ["each Retained-Path line must use: Retained-Path: <path> until <YYYY-MM-DD> per <decision-id>"];
  return { declarations, errors };
}

function validateRetainedPath({ declaration, rootDir, base, receipts, now }) {
  const errors = [];
  const normalized = normalizeRepoPath(declaration.path);
  if (normalized === null || normalized !== declaration.path || !isProductionPath(normalized)) {
    errors.push(`Retained-Path must name a normalized production source path: ${declaration.path}`);
    return errors;
  }
  if (!pathExistsAt(rootDir, base, normalized) || !existsSync(path.join(rootDir, normalized))) {
    errors.push(`Retained-Path must exist at both base and HEAD: ${normalized}`);
  }

  const endOfExpiryDay = Date.parse(`${declaration.until}T23:59:59Z`);
  if (Number.isNaN(endOfExpiryDay) || endOfExpiryDay <= now.getTime())
    errors.push(`Retained-Path expiry must be in the future: ${declaration.until}`);

  const matchingReceipt = receipts.find(
    ({ receipt }) =>
      verifyReceipt(receipt, {
        scope: `retained-path:${normalized}`,
        kind: "retained-path",
        decisionId: declaration.decisionId,
        limit: declaration.until,
        now,
      }).ok && Date.parse(receipt.expiry) >= endOfExpiryDay,
  );
  if (matchingReceipt === undefined) {
    errors.push(
      `Retained-Path ${normalized} lacks a valid receipt for ${declaration.decisionId} through ${declaration.until}`,
    );
  }
  return errors;
}

export function evaluateProductionDelta({
  rootDir,
  base,
  prBody,
  receiptsDir = path.join(rootDir, "tools/gates/receipts"),
  now = new Date(),
}) {
  const computed = computeProductionDelta({ rootDir, base });
  const parsedDelta = parseProductionDeclaration(prBody);
  const parsedRetained = parseRetainedPaths(prBody);
  const receipts = loadReceipts(receiptsDir);
  const errors = [...parsedDelta.errors, ...parsedRetained.errors];

  for (const filePath of computed.unclassified)
    errors.push(`production source is not classified by module-policy: ${filePath}`);
  if (
    parsedDelta.declaration !== null &&
    (parsedDelta.declaration.added !== computed.added || parsedDelta.declaration.deleted !== computed.deleted)
  ) {
    errors.push(
      `declared Production-Delta +${parsedDelta.declaration.added}/-${parsedDelta.declaration.deleted} does not match computed +${computed.added}/-${computed.deleted}`,
    );
  }
  for (const declaration of parsedRetained.declarations) {
    errors.push(...validateRetainedPath({ declaration, rootDir, base, receipts, now }));
  }

  return {
    ok: errors.length === 0,
    errors,
    computed,
    declaration: parsedDelta.declaration,
    retainedPaths: parsedRetained.declarations,
  };
}

function parseArgs(argv) {
  let base = null;
  let prBodyFile = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") base = argv[(index += 1)] ?? null;
    else if (argv[index] === "--pr-body-file") prBodyFile = argv[(index += 1)] ?? null;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (base === null)
    throw new Error("usage: node tools/gates/production-delta.mjs --base <sha> [--pr-body-file <path>]");
  return { base, prBodyFile };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { base, prBodyFile } = parseArgs(argv);
    if (
      prBodyFile === null &&
      isMergifyQueueDraft({
        headRefName: process.env.PR_HEAD_REF ?? "",
        authorLogin: process.env.PR_AUTHOR_LOGIN ?? "",
      })
    ) {
      console.log(
        "production-delta: skipped for Mergify merge-queue verification PR (the queued PR carries the declaration).",
      );
      return 0;
    }
    const rootDir = repoRoot();
    const prBody = prBodyFile === null ? process.env.PR_BODY : readFileSync(prBodyFile, "utf8");
    if (prBody === undefined) throw new Error("PR body is required through PR_BODY or --pr-body-file");
    const result = evaluateProductionDelta({ rootDir, base, prBody });
    writeCiGateResult("G33", result.ok, {
      addedLines: result.computed.added,
      deletedLines: result.computed.deleted,
      changedFiles: result.computed.changed.length,
      retainedPaths: result.retainedPaths.length,
    });
    console.log(`production +${result.computed.added}/-${result.computed.deleted}`);
    if (!result.ok) {
      for (const error of result.errors) console.error(`G33 production-delta: ${error}`);
      return 1;
    }
    console.log("G33 production-delta: pass");
    return 0;
  } catch (error) {
    writeCiGateResult("G33", false, {});
    console.error(`G33 production-delta: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
