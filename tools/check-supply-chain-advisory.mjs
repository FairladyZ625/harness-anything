// Scheduled advisory supply-chain lane.
//
// Live `npm audit` resolves advisories from the upstream registry, so its verdict changes
// without any change to this repository. That makes it unfit to be a required merge gate:
// one newly published advisory would turn every open pull request red at once
// (dec_01KYB7TMSPAASW4XTAAA0CVH5W, CH2). It still runs — here — on a schedule, and a finding
// still turns this job red so it stays visible. It simply does not gate merges.
//
// The required lane keeps the deterministic, repository-self-contained evidence:
// lockfile license/integrity policy and CycloneDX SBOM structure (tools/check-supply-chain.mjs).

import { spawnSync } from "node:child_process";
import { harnessSupplyChainReleaseReadiness } from "../packages/gui/src/distribution/supply-chain-release-readiness.ts";
import { isTransientRegistryError } from "./supply-chain-transient-error.mjs";

const root = process.cwd();
const policy = harnessSupplyChainReleaseReadiness;
const COMMAND_TIMEOUT_MS = 180_000;
const ATTEMPTS = 3;

const advisoryCommands = policy.auditCommands.filter((command) => !command.requiredInDefaultCheck);

if (advisoryCommands.length === 0) {
  // Not a success: the advisory lane exists so these commands keep running somewhere. An
  // empty lane means they now run nowhere, which is exactly the blind spot this file prevents.
  console.error(
    "Supply chain advisory lane has no commands to run; live audit coverage would be lost entirely."
  );
  process.exit(1);
}

const findings = [];
const transient = [];

for (const command of advisoryCommands) {
  const outcome = runAudit(command);
  if (outcome.kind === "finding") findings.push(outcome);
  if (outcome.kind === "transient") transient.push(outcome);
}

for (const entry of transient) {
  console.error(`[supply-chain-advisory] ${entry.name} could not reach the registry: ${entry.summary}`);
}

if (findings.length > 0) {
  console.error("Supply chain advisory findings (these do not block merges, but they are real):");
  for (const finding of findings) {
    console.error(`\n- ${finding.name} (${finding.command}) reported:\n${finding.output}`);
  }
  console.error(
    "\nTriage: patch-level lockfile fixes may be applied directly. A fix that needs a major " +
      "bump or an npm override is out of mechanical scope and needs its own adjudication."
  );
  process.exit(1);
}

if (transient.length > 0) {
  // Registry unreachable is not evidence of safety. Fail loudly rather than report a green
  // lane we did not actually establish.
  console.error("Supply chain advisory lane could not complete: registry unreachable.");
  process.exit(1);
}

console.log(
  `Supply chain advisory lane passed ${advisoryCommands.length} live audit command(s) with no high-severity findings.`
);

function runAudit(command) {
  const [binary, ...args] = command.command.split(" ");

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const result = spawnSync(binary, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
      detached: process.platform !== "win32"
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

    if (result.error?.code === "ETIMEDOUT" || result.signal !== null) {
      if (attempt < ATTEMPTS) continue;
      return { kind: "transient", name: command.name, summary: `timed out after ${ATTEMPTS} attempts` };
    }
    if (result.error) {
      if (attempt < ATTEMPTS) continue;
      return { kind: "transient", name: command.name, summary: result.error.message };
    }
    if (result.status === 0) {
      console.log(`[supply-chain-advisory] ${command.name} clean`);
      return { kind: "clean", name: command.name };
    }
    if (isTransientRegistryError(output) && attempt < ATTEMPTS) continue;
    if (isTransientRegistryError(output)) {
      return { kind: "transient", name: command.name, summary: output.split("\n", 1)[0] };
    }

    return { kind: "finding", name: command.name, command: command.command, output };
  }

  return { kind: "transient", name: command.name, summary: "exhausted attempts" };
}
