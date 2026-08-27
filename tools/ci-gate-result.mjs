import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function writeCiGateResult(gate, pass, metrics) {
  const destination = process.env.HARNESS_CI_GATE_RESULTS;
  if (!destination) return;
  const prior = existsSync(destination) ? JSON.parse(readFileSync(destination, "utf8")) : [];
  if (!Array.isArray(prior)) throw new Error("CI gate results must be an array");
  const row = { gate, pass, metrics };
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify([...prior.filter((entry) => entry?.gate !== gate), row])}\n`);
}
