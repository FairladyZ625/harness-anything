#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "prettier";
import { getEntityKindContract } from "../packages/kernel/src/index.ts";

const root = path.resolve(import.meta.dirname, "..");
const protocolTarget = path.join(root, "packages/daemon/src/protocol/daemon-protocol-commands-task.ts");
const protocolMarkers = {
  start: "// task-action-projection:generated:start",
  end: "// task-action-projection:generated:end",
};

export function projectTaskActionProtocolDeclarations() {
  const actions = getEntityKindContract("task")?.actionCatalog?.actions ?? [];
  if (actions.length !== 4 || actions.some((action) => action.execution?.topology === undefined)) {
    throw new Error("Task start, submit, review, and complete must all have executable command topology.");
  }
  return actions.map(({ id, input, explain, execution }) => ({ id, input, explain, execution }));
}

export async function renderTaskActionProtocolProjection() {
  const literal = JSON.stringify(projectTaskActionProtocolDeclarations(), null, 2),
    source = [
      protocolMarkers.start,
      "export const generatedTaskActionProtocolDeclarations = Object.freeze(",
      `  ${literal} as const satisfies readonly GeneratedTaskActionProtocolDeclaration[],`,
      ");",
      protocolMarkers.end,
    ].join("\n");
  return (await format(source, { parser: "typescript", printWidth: 120 })).trimEnd();
}

function generatedRegion(source, target) {
  const start = source.indexOf(protocolMarkers.start);
  const end = source.indexOf(protocolMarkers.end, start);
  if (start < 0 || end < 0) throw new Error(`Generated Task Action projection markers are missing in ${target}.`);
  return source.slice(start, end + protocolMarkers.end.length);
}

function replaceGeneratedRegion(target, rendered) {
  const source = readFileSync(target, "utf8");
  const current = generatedRegion(source, target);
  const start = source.indexOf(current);
  writeFileSync(target, `${source.slice(0, start)}${rendered}${source.slice(start + current.length)}`);
}

export async function generateTaskActionProtocolProjection() {
  replaceGeneratedRegion(protocolTarget, await renderTaskActionProtocolProjection());
}

export async function checkTaskActionProtocolProjection() {
  const source = readFileSync(protocolTarget, "utf8"),
    current = generatedRegion(source, protocolTarget),
    expected = await renderTaskActionProtocolProjection();
  if (current !== expected) {
    throw new Error("Generated Task Action protocol projection is stale; run tools/generate-task-action-protocol.mjs.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) await checkTaskActionProtocolProjection();
  else await generateTaskActionProtocolProjection();
}
