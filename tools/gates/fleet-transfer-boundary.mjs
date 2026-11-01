import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FLEET_SOURCES = [
  "packages/daemon/src/fleet/peer.ts",
  "packages/daemon/src/fleet/center-transport.ts",
  "packages/daemon/src/fleet/center-listener.ts",
  "packages/daemon/src/daemon-host-repository-api.ts",
];

/** Return structural violations that would let a new Fleet RPC bypass the transfer boundary. */
export function findFleetTransferBypasses(sourceText, fileName = "inline.ts") {
  const violations = [];
  for (const [index, line] of String(sourceText).split(/\r?\n/u).entries()) {
    if (/socket\.write\(\s*JSON\.stringify\(/u.test(line))
      violations.push({ file: fileName, line: index + 1, reason: "direct JSON socket write" });
    if (/fleet\.task\.evidence\/v1/u.test(line))
      violations.push({ file: fileName, line: index + 1, reason: "retired per-read evidence transport" });
    if (/assertFleetReadFits\(/u.test(line) && !/function assertFleetReadFits/u.test(line))
      violations.push({ file: fileName, line: index + 1, reason: "read face owns the Fleet frame limit" });
  }
  return violations;
}

export function checkFleetTransferBoundary(rootDir) {
  const errors = [];
  for (const relative of FLEET_SOURCES) {
    const file = path.join(rootDir, relative);
    if (!existsSync(file)) {
      errors.push(`${relative}: Fleet transport source is missing`);
      continue;
    }
    const source = readFileSync(file, "utf8");
    if (
      (relative.endsWith("peer.ts") || relative.endsWith("center-transport.ts")) &&
      !source.includes("encodeFleetFrames")
    )
      errors.push(`${relative}: command writes must pass through encodeFleetFrames`);
    for (const violation of findFleetTransferBypasses(source, relative))
      errors.push(`${violation.file}:${violation.line}: ${violation.reason}`);
  }
  return errors;
}

async function main() {
  if (!process.argv.includes("--check")) throw new Error("usage: node tools/gates/fleet-transfer-boundary.mjs --check");
  const errors = checkFleetTransferBoundary(process.cwd());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("fleet-transfer-boundary: ok");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
