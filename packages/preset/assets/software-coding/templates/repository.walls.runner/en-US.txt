#!/usr/bin/env node
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const wallsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(wallsDir, "../../..");
const manifest = JSON.parse(readFileSync(join(wallsDir, "walls.json"), "utf8"));
if (manifest.schema !== "walls/v1" || !Array.isArray(manifest.walls)) throw new Error("walls.json must use walls/v1 with a walls array");

function runWall(wall) {
  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execSync(wall.cmd, { cwd: repoRoot, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (error) {
    stdout = error.stdout?.toString() ?? "";
    exitCode = typeof error.status === "number" ? error.status : 1;
  }
  const hits = stdout.trim() === "" ? 0 : stdout.trim().split("\n").length;
  const satisfied = wall.expect === "hits==0" ? hits === 0 : wall.expect === "hits>=1" ? hits >= 1 : wall.expect === "exit==0" ? exitCode === 0 : (() => { throw new Error(`unknown expect: ${wall.expect} (${wall.id})`); })();
  const verdict = wall.state === "guarding" || wall.state === "retired-by-supersession" ? satisfied ? "PASS" : "RED" : wall.state === "known-issue" ? satisfied ? "NOTICE" : "EXPECTED" : wall.state === "condition-pending" ? "INFO" : (() => { throw new Error(`unknown state: ${wall.state} (${wall.id})`); })();
  return { ...wall, hits, exitCode, satisfied, verdict };
}

const results = manifest.walls.map(runWall);
const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
const summary = `WALLS pass=${count("PASS")} red=${count("RED")} expected=${count("EXPECTED")} notice=${count("NOTICE")} info=${count("INFO")} total=${results.length}`;
const needsReport = count("RED") > 0 || count("NOTICE") > 0;
let reportPath = null;
if (needsReport) {
  const now = new Date();
  const lines = ["# Walls report", "", summary, "", "| Wall | State | Verdict | Satisfied | Note |", "|---|---|---|---|---|", ...results.map((result) => `| ${result.id} | ${result.state} | **${result.verdict}** | ${result.satisfied ? "yes" : "no"} | ${result.note ?? ""} |`)];
  const reportsDir = join(wallsDir, "reports");
  mkdirSync(reportsDir, { recursive: true });
  reportPath = join(reportsDir, `walls-${now.toISOString().replace(/[:T]/g, "-").slice(0, 16)}.md`);
  writeFileSync(reportPath, `${lines.join("\n")}\n`);
}

for (const result of results) console.log(`${result.verdict.padEnd(8)} ${result.id}`);
console.log(summary);
console.log(reportPath ? `report: ${reportPath}` : "report: none");
process.exitCode = count("RED") > 0 ? 1 : 0;
