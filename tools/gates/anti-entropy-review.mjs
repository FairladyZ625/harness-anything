import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { changedFiles, repoRoot } from "./git.mjs";
import { classifyModule, isProductionPath, normalizeRepoPath } from "./module-policy.mjs";
import { verifyReceipt } from "./receipt-verify.mjs";

const RECEIPT_LINE = /^Anti-Entropy-Receipt:\s*(\S+)\s*$/gmu;

function replayScope(paths) {
  const modules = [...new Set(paths.filter(isProductionPath).map(classifyModule).filter((value) => value !== null))].sort();
  return modules.length === 0 ? null : `replay:${modules.join(",")}`;
}

export function evaluateAntiEntropyReview({ rootDir, event, paths, now = new Date() }) {
  const pullRequest = event?.pull_request;
  if (pullRequest === undefined) return { ok: true, status: "N/A", errors: [], scope: null };
  const scope = replayScope(paths);
  if (scope === null) return { ok: true, status: "N/A", errors: [], scope };
  const headSha = pullRequest.head?.sha;
  const body = pullRequest.body ?? "";
  const declarations = [...body.matchAll(RECEIPT_LINE)].map((match) => match[1]);
  if (declarations.length !== 1) {
    return { ok: false, status: "pending", errors: [`replay PR requires exactly one Anti-Entropy-Receipt: <path> line; found ${declarations.length}`], scope };
  }
  const receiptPath = normalizeRepoPath(declarations[0]);
  if (receiptPath === null || !receiptPath.startsWith("tools/gates/receipts/") || !receiptPath.endsWith(".json")) {
    return { ok: false, status: "rejected", errors: ["Anti-Entropy-Receipt must name a normalized JSON file under tools/gates/receipts/"], scope };
  }
  const absolutePath = path.join(rootDir, receiptPath);
  if (!existsSync(absolutePath)) return { ok: false, status: "pending", errors: [`anti-entropy receipt not found: ${receiptPath}`], scope };
  const receipt = JSON.parse(readFileSync(absolutePath, "utf8"));
  const verification = verifyReceipt(receipt, { kind: "anti-entropy-review", verdict: "approved", headSha, scope, now });
  return { ok: verification.ok, status: verification.ok ? "approved" : receipt.verdict ?? "rejected", errors: verification.errors, scope };
}

function parseArgs(argv) {
  const index = argv.indexOf("--event");
  if (index === -1 || argv[index + 1] === undefined || argv.length !== 2) throw new Error("usage: node tools/gates/anti-entropy-review.mjs --event <path>");
  return argv[index + 1];
}

export function main(argv = process.argv.slice(2)) {
  const eventPath = parseArgs(argv);
  const rootDir = repoRoot();
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha ?? "HEAD";
  const paths = base === undefined ? [] : changedFiles(rootDir, base, head);
  const result = evaluateAntiEntropyReview({ rootDir, event, paths });
  console.log(`anti-entropy-review: ${result.status}${result.scope === null ? "" : ` (${result.scope})`}`);
  if (!result.ok) for (const error of result.errors) console.error(`G35 anti-entropy-review: ${error}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
