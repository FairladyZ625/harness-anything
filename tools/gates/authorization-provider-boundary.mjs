import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_ROOTS = ["packages/"];
const PROVIDER_PACKAGE_PREFIX = "packages/authorization-keycloak";
const EXEMPTED_TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|fixtures?)(?:\/|\.)|\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const PROVIDER_MARKER =
  /keycloak|\badmin-cli\b|realm_access|keycloak_unavailable|keycloak-user:|\/realms\/|\/admin\/(?:[^"'\s]+\/console\/|serverinfo\b)|\brealm[_-]?role\b|\bclient(?:id|secret)\b/iu;
const REALM_FIELD = /(?:["']realm["']|(?:\.|\b)realm)\s*(?::|=)/u;
const WAIVER_PATH = "tools/gate-allowlists/authorization-provider-boundary.json";

export function providerMarkerReason(line) {
  if (PROVIDER_MARKER.test(line)) return "Keycloak-specific symbol, error, or REST path";
  if (REALM_FIELD.test(line)) return "provider-specific realm field";
  return null;
}

export function providerLineFingerprint(file, sourceLine) {
  return createHash("sha256").update(`${file}\0${sourceLine.trim()}`).digest("hex");
}

export function findProviderBoundaryViolations(diffText, waivedFingerprints = []) {
  const errors = [];
  let file = "";
  for (const line of String(diffText).split(/\r?\n/u)) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (!SOURCE_ROOTS.some((root) => file.startsWith(root))) continue;
    const isProviderPackage =
      file.startsWith(`${PROVIDER_PACKAGE_PREFIX}/`) || file.startsWith(`${PROVIDER_PACKAGE_PREFIX}-`);
    if (isProviderPackage || EXEMPTED_TEST_PATH.test(file)) continue;
    const sourceLine = line.slice(1);
    if (waivedFingerprints.includes(providerLineFingerprint(file, sourceLine))) continue;
    const reason = providerMarkerReason(sourceLine);
    if (reason) errors.push(`${file}: ${reason}: ${line.slice(1).trim()}`);
  }
  return errors;
}

/**
 * A fingerprint waives one exact legacy source line. Once that line is gone from every governed
 * source file the waiver is stale: it permits nothing today and would silently re-admit the same
 * line if it were ever written again, so the waiver has to be deleted with the line it covered.
 */
export function findStaleFingerprints(fingerprints, sourceFiles) {
  const present = new Set();
  for (const { file, text } of sourceFiles)
    for (const sourceLine of String(text).split(/\r?\n/u)) present.add(providerLineFingerprint(file, sourceLine));
  return fingerprints
    .filter((fingerprint) => !present.has(fingerprint))
    .map((fingerprint) => `${WAIVER_PATH}: line fingerprint ${fingerprint} matches no current source line; delete it`);
}

function governedSourceFiles(rootDir) {
  return execFileSync("git", ["ls-files", "--", ...SOURCE_ROOTS], { cwd: rootDir, encoding: "utf8" })
    .split("\n")
    .filter((file) => file && !file.startsWith(PROVIDER_PACKAGE_PREFIX) && !EXEMPTED_TEST_PATH.test(file))
    .map((file) => ({ file, text: readFileSync(path.join(rootDir, file), "utf8") }));
}

export function findExpiredWaivers(waivers, today) {
  return waivers.entries
    .filter((entry) => entry.expiresOn <= today)
    .map((entry) => `${entry.scope}: waiver expired ${entry.expiresOn} (${entry.remediationTask})`);
}

export function checkAuthorizationProviderBoundary(rootDir) {
  const diff = execFileSync("git", ["diff", "--unified=0", "origin/main", "--", "packages"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  const allowlist = JSON.parse(readFileSync(path.join(rootDir, WAIVER_PATH), "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const fingerprints = allowlist.entries.lineFingerprints ?? [];
  return [
    ...findProviderBoundaryViolations(diff, fingerprints),
    ...(fingerprints.length ? findStaleFingerprints(fingerprints, governedSourceFiles(rootDir)) : []),
    ...findExpiredWaivers({ entries: allowlist.entries.providerWaivers }, today),
  ];
}

async function main() {
  if (!process.argv.includes("--check"))
    throw new Error("usage: node tools/gates/authorization-provider-boundary.mjs --check");
  const errors = checkAuthorizationProviderBoundary(process.cwd());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("authorization-provider-boundary: ok");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
