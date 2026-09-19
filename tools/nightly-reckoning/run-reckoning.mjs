#!/usr/bin/env node
import { resolve } from "node:path";
import { collectReckoning, renderReport } from "./reckoning.mjs";

function values(name) {
  return process.argv
    .slice(2)
    .flatMap((value, index, all) => (value === name && all[index + 1] ? [all[index + 1]] : []));
}

const root = resolve(values("--root").at(-1) ?? process.cwd());
const databasePath = resolve(values("--db").at(-1) ?? `${root}/.harness/cache/task.sqlite`);
const now = values("--now").at(-1) ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(now))) throw new Error("--now must be an ISO timestamp");
const until = Date.parse(now);
const since = until - 86_400_000;
const signals = await collectReckoning({ root, databasePath, since, until, sources: values("--source") });
process.stdout.write(renderReport({ generatedAt: now, since, signals }));
