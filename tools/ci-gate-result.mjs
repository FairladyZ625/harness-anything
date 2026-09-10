import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function writeCiGateResult(gate, result, metrics) {
  const destination = process.env.HARNESS_CI_GATE_RESULTS;
  if (!destination) return;
  const prior = existsSync(destination) ? JSON.parse(readFileSync(destination, "utf8")) : [];
  if (!Array.isArray(prior)) throw new Error("CI gate results must be an array");
  if (!["pass", "fail", "advisory", "not_run"].includes(result)) throw new Error("CI gate result is invalid");
  const row = { gate, result, metrics };
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify([...prior.filter((entry) => entry?.gate !== gate), row])}\n`);
}
