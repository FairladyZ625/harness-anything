import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const COMMON_FIELDS = Object.freeze(["run-url", "commit-sha", "failed-test", "scope", "owner"]);
const PERFORMANCE_FIELDS = Object.freeze(["fixture", "phase", "baseline"]);
const SHA = /^[0-9a-f]{40}$/iu;
const FIELD = /^([A-Za-z][A-Za-z-]*):\s*(.*?)\s*$/u;

function claimType(line) {
  const match = /^(Evidence-Type|CI-Attribution|Performance-Claim):\s*(.*?)\s*$/iu.exec(line);
  if (match === null) return null;
  if (match[1].toLowerCase() === "ci-attribution") return "ci";
  if (match[1].toLowerCase() === "performance-claim") return "performance";
  const value = match[2].toLowerCase();
  return value === "ci" || value === "performance" ? value : "unknown";
}

export function parseEvidenceClaims(body) {
  const claims = [];
  let current = null;
  for (const line of body.split(/\r?\n/u)) {
    const type = claimType(line);
    if (type !== null) {
      current = { type, fields: {} };
      claims.push(current);
      continue;
    }
    if (current === null) continue;
    const field = FIELD.exec(line);
    if (field !== null) current.fields[field[1].toLowerCase()] = field[2];
  }
  return claims;
}

function validRunUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = URL.parse(value);
  return parsed !== null && parsed.protocol === "https:" && /\/actions\/runs\/\d+(?:\/|$)/u.test(parsed.pathname);
}

function validBaseline(value) {
  if (typeof value !== "string") return false;
  if (SHA.test(value)) return true;
  const parsed = URL.parse(value);
  return parsed !== null && parsed.protocol === "https:";
}

export function validateEvidenceBody(body) {
  const claims = parseEvidenceClaims(body);
  const errors = [];
  for (const [index, claim] of claims.entries()) {
    const label = `claim ${index + 1}`;
    if (!new Set(["ci", "performance"]).has(claim.type)) errors.push(`${label}: Evidence-Type must be ci or performance`);
    for (const field of COMMON_FIELDS) {
      if (claim.fields[field] === undefined || claim.fields[field].length === 0) errors.push(`${label}: missing ${field}`);
    }
    if (claim.fields["run-url"] !== undefined && !validRunUrl(claim.fields["run-url"])) errors.push(`${label}: run-url must be an HTTPS CI run URL`);
    if (claim.fields["commit-sha"] !== undefined && !SHA.test(claim.fields["commit-sha"])) errors.push(`${label}: commit-sha must be a full 40-character SHA`);
    if (claim.type === "performance") {
      for (const field of PERFORMANCE_FIELDS) {
        if (claim.fields[field] === undefined || claim.fields[field].length === 0) errors.push(`${label}: missing ${field}`);
      }
      if (claim.fields.baseline !== undefined && !validBaseline(claim.fields.baseline)) {
        errors.push(`${label}: baseline must identify a paired SHA or evidence URL`);
      }
    }
  }
  return { status: errors.length === 0 ? (claims.length === 0 ? "N/A" : "verified") : "unknown", claims, errors };
}

function eventBody(event) {
  if (typeof event?.pull_request?.body === "string") return event.pull_request.body;
  if (typeof event?.issue?.body === "string") return event.issue.body;
  return "";
}

export function evaluateEvidenceEvent(event) {
  return validateEvidenceBody(eventBody(event));
}

function parseArgs(argv) {
  const index = argv.indexOf("--event");
  if (index === -1 || argv[index + 1] === undefined || argv.length !== 2) {
    throw new Error("usage: node tools/gates/evidence-contract.mjs --event <path>");
  }
  return argv[index + 1];
}

export function main(argv = process.argv.slice(2)) {
  const eventPath = parseArgs(argv);
  const result = evaluateEvidenceEvent(JSON.parse(readFileSync(eventPath, "utf8")));
  console.log(`evidence-contract: ${result.status}`);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`G17 evidence-contract: ${error}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
