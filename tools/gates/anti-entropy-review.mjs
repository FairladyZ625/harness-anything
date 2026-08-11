import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { changedFiles, repoRoot } from "./git.mjs";
import { classifyModule, isProductionPath } from "./module-policy.mjs";
import { antiEntropyVerificationKey, decodeReceiptToken, verifyReceipt } from "./receipt-verify.mjs";

const TOKEN_LINE = /^Anti-Entropy-Token:[ \t]*(\S+)[ \t]*\r?$/gmu;
const HEAD_SHA = /^[0-9a-f]{40}$/u;
const MAXIMUM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const NEXT_ACTION = Object.freeze({
  key: "provision ANTI_ENTROPY_HMAC_KEY as a workflow secret (CI) or environment variable (local), then rerun G35",
  token: "request an independent review and CEO-signed token for the current HEAD and replay scope, then set exactly one Anti-Entropy-Token line in the PR body"
});

function replayScope(paths) {
  const modules = [...new Set(paths.filter(isProductionPath).map(classifyModule).filter((value) => value !== null))].sort();
  return modules.length === 0 ? null : `replay:${modules.join(",")}`;
}

function failure(status, errors, scope, nextAction) {
  return { ok: false, status, errors, scope, nextAction };
}

export function evaluateAntiEntropyReview({ event, paths, now = new Date(), key = antiEntropyVerificationKey() }) {
  const pullRequest = event?.pull_request;
  if (pullRequest === undefined) return { ok: true, status: "N/A", errors: [], scope: null };
  const scope = replayScope(paths);
  if (scope === null) return { ok: true, status: "N/A", errors: [], scope };
  const headSha = pullRequest.head?.sha;
  if (typeof headSha !== "string" || !HEAD_SHA.test(headSha)) {
    return failure("rejected", ["pull request event must include a full lowercase head SHA"], scope, "regenerate the trusted pull request event and rerun G35");
  }
  const body = pullRequest.body ?? "";
  const tokenLines = body.split(/\r?\n/u).filter((line) => line.startsWith("Anti-Entropy-Token:"));
  const declarations = [...body.matchAll(TOKEN_LINE)].map((match) => match[1]);
  if (tokenLines.length !== 1 || declarations.length !== 1) {
    return failure(
      "pending",
      [`replay PR requires exactly one valid Anti-Entropy-Token: <base64url> line; found ${tokenLines.length}`],
      scope,
      NEXT_ACTION.token
    );
  }
  const decoded = decodeReceiptToken(declarations[0]);
  if (decoded.errors.length > 0) {
    return failure("rejected", decoded.errors, scope, NEXT_ACTION.token);
  }
  if (key === null) return failure("pending", ["ANTI_ENTROPY_HMAC_KEY is missing"], scope, NEXT_ACTION.key);

  const receipt = decoded.receipt;
  const verification = verifyReceipt(receipt, {
    key,
    kind: "anti-entropy-review",
    verdict: "approved",
    headSha,
    scope,
    now,
    maximumTtlMs: MAXIMUM_TOKEN_TTL_MS
  });
  if (!verification.ok) {
    const status = receipt?.verdict === "pending" ? "pending" : "rejected";
    return failure(status, verification.errors, scope, NEXT_ACTION.token);
  }
  return { ok: true, status: "approved", errors: [], scope };
}

function parseArgs(argv) {
  const index = argv.indexOf("--event");
  if (index === -1 || argv[index + 1] === undefined || argv.length !== 2) throw new Error("usage: node tools/gates/anti-entropy-review.mjs --event <path>");
  return argv[index + 1];
}

export function main(argv = process.argv.slice(2)) {
  try {
    const eventPath = parseArgs(argv);
    const rootDir = repoRoot();
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const base = event.pull_request?.base?.sha;
    const head = event.pull_request?.head?.sha ?? "HEAD";
    const paths = base === undefined ? [] : changedFiles(rootDir, base, head);
    const result = evaluateAntiEntropyReview({ event, paths });
    console.log(`anti-entropy-review: ${result.status}${result.scope === null ? "" : ` (${result.scope})`}`);
    if (!result.ok) {
      for (const error of result.errors) console.error(`G35 anti-entropy-review: ${error}`);
      console.error(`G35 anti-entropy-review: nextAction: ${result.nextAction}`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(`G35 anti-entropy-review: ${error.message}`);
    console.error("G35 anti-entropy-review: nextAction: verify the trusted base checkout and pull request event, then rerun G35");
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
