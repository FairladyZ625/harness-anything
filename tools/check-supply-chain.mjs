import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    console.error(output);
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

run("npm", ["audit", "--audit-level=high"]);
run("npm", ["audit", "--omit=dev", "--audit-level=high"]);

const sbom = run("npm", [
  "sbom",
  "--sbom-format=cyclonedx",
  "--sbom-type=application"
]);

let parsed;
try {
  parsed = JSON.parse(sbom);
} catch {
  console.error("npm sbom did not emit valid JSON");
  process.exit(1);
}

if (parsed.bomFormat !== "CycloneDX" || !Array.isArray(parsed.components)) {
  console.error("npm sbom output is missing the expected CycloneDX component list");
  process.exit(1);
}

console.log(`Supply chain check passed with ${parsed.components.length} SBOM components.`);
