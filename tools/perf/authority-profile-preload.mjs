import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const outputPath = process.env.AUTHORITY_PROFILE_OUTPUT;
const counters = new Map();

function record(name, startedAt) {
  const elapsedNs = Number(process.hrtime.bigint() - startedAt);
  const counter = counters.get(name) ?? { count: 0, totalNs: 0, maxNs: 0 };
  counter.count += 1;
  counter.totalNs += elapsedNs;
  counter.maxNs = Math.max(counter.maxNs, elapsedNs);
  counters.set(name, counter);
}

function wrap(target, name, label) {
  const original = target[name];
  target[name] = function profiled(...args) {
    const startedAt = process.hrtime.bigint();
    try {
      return original.apply(this, args);
    } finally {
      record(label(args), startedAt);
    }
  };
}

wrap(childProcess, "execFileSync", (args) => {
  const executable = String(args[0] ?? "unknown").split("/").at(-1);
  const commandArgs = Array.isArray(args[1]) ? args[1] : [];
  const commandIndex = commandArgs.indexOf("-C");
  const subcommand = executable === "git"
    ? commandArgs[commandIndex >= 0 ? commandIndex + 2 : 0]
    : undefined;
  return subcommand ? `execFileSync:${executable}:${subcommand}` : `execFileSync:${executable}`;
});

for (const name of [
  "closeSync",
  "existsSync",
  "fsyncSync",
  "mkdirSync",
  "openSync",
  "readFileSync",
  "renameSync",
  "rmSync",
  "unlinkSync",
  "writeFileSync",
  "writeSync"
]) {
  wrap(fs, name, () => `fs:${name}`);
}

syncBuiltinESMExports();

process.on("exit", () => {
  if (!outputPath) return;
  const measurements = Object.fromEntries([...counters]
    .sort((left, right) => right[1].totalNs - left[1].totalNs)
    .map(([name, counter]) => [name, {
      count: counter.count,
      totalMs: Math.round(counter.totalNs / 10_000) / 100,
      meanMs: Math.round(counter.totalNs / counter.count / 10_000) / 100,
      maxMs: Math.round(counter.maxNs / 10_000) / 100
    }]));
  fs.writeFileSync(outputPath, `${JSON.stringify({
    schema: "authority-concurrency-profile/v1",
    measurements
  }, null, 2)}\n`);
});
