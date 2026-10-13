#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const nodes = positiveInt(args.nodes ?? "10", "--nodes");
const rate = positiveNumber(args["events-per-second"] ?? "1", "--events-per-second");
const duration = positiveInt(args.duration ?? "60", "--duration");
const delayMs = nonNegativeNumber(args["delay-ms"] ?? "0", "--delay-ms");
const bandwidthKbps = nonNegativeNumber(args["bandwidth-kbps"] ?? "0", "--bandwidth-kbps");
const output = path.resolve(args.output ?? `fleet-load-${Date.now()}.json`);
const command = args.command;
if (!command) throw new Error("--command is required (a command that accepts FLEET_NODE_ID and FLEET_EVENT_ID)");

await mkdir(path.dirname(output), { recursive: true });
const startedAt = Date.now();
const samples = [];
const failures = [];
const intervalMs = 1000 / rate;
let sequence = 0;

const deadline = startedAt + duration * 1000;
while (Date.now() < deadline) {
  const eventId = `fleet-load-${++sequence}`;
  const issuedAt = Date.now();
  const env = {
    ...process.env,
    FLEET_EVENT_ID: eventId,
    FLEET_EVENT_ISSUED_AT_MS: String(issuedAt),
    FLEET_DELAY_MS: String(delayMs),
    FLEET_BANDWIDTH_KBPS: String(bandwidthKbps),
  };
  const results = await Promise.all(
    Array.from({ length: nodes }, (_, index) => run(command, { ...env, FLEET_NODE_ID: `edge-${index + 1}` })),
  );
  const completedAt = Date.now();
  results.forEach((result, index) => {
    const nodeId = `edge-${index + 1}`;
    if (result.code === 0) samples.push({ nodeId, eventId, issuedAt, completedAt, latencyMs: completedAt - issuedAt });
    else
      failures.push({ nodeId, eventId, issuedAt, completedAt, code: result.code, stderr: result.stderr.slice(-2000) });
  });
  const wait = Math.max(0, intervalMs - (Date.now() - issuedAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
}
const report = {
  schema: "fleet-replica-load/v1",
  generatedAt: new Date().toISOString(),
  parameters: { nodes, rate, duration, delayMs, bandwidthKbps, command },
  samples,
  failures,
  summary: summarize(samples, failures, startedAt),
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output, summary: report.summary })}\n`);

function run(commandLine, env) {
  return new Promise((resolve) => {
    const child = spawn(commandLine, { shell: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

function summarize(samples, failures, startedAt) {
  const values = samples.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
  const percentile = (p) =>
    values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] : null;
  return {
    elapsedMs: Date.now() - startedAt,
    completed: samples.length,
    failed: failures.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    monotonic: samples.every((sample, index) => index === 0 || sample.issuedAt >= samples[index - 1].issuedAt),
  };
}

function parseArgs(raw) {
  const result = {};
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item.startsWith("--")) throw new Error(`unexpected argument ${item}`);
    const key = item.slice(2);
    result[key] = raw[index + 1];
    index += 1;
  }
  return result;
}
function positiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}
function nonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be non-negative`);
  return parsed;
}
