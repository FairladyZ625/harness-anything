#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getEntityKindContract } from "../packages/kernel/src/index.ts";

const root = path.resolve(import.meta.dirname, "..");
const protocolTarget = path.join(root, "packages/daemon/src/protocol/daemon-protocol-commands-task.ts");
const packetFieldsTarget = path.join(root, "packages/preset/src/preset-command-contract.ts");
const protocolMarkers = {
  start: "// task-action-projection:generated:start",
  end: "// task-action-projection:generated:end",
};
const packetFieldMarkers = {
  start: "// task-action-json-fields:generated:start",
  end: "// task-action-json-fields:generated:end",
};

export function projectTaskActionProtocolDeclarations() {
  const actions = getEntityKindContract("task")?.actionCatalog?.actions ?? [];
  if (actions.length !== 4 || actions.some((action) => action.execution?.topology === undefined)) {
    throw new Error("Task start, submit, review, and complete must all have executable command topology.");
  }
  return actions.map(({ id, input, explain, execution }) => ({ id, input, explain, execution }));
}

export function renderTaskActionProtocolProjection() {
  const literal = JSON.stringify(projectTaskActionProtocolDeclarations(), null, 2);
  return [
    protocolMarkers.start,
    "export const generatedTaskActionProtocolDeclarations = Object.freeze(",
    `  ${literal} as const satisfies readonly GeneratedTaskActionProtocolDeclaration[],`,
    ");",
    protocolMarkers.end,
  ].join("\n");
}

export function renderTaskActionPacketFields() {
  const declarations = projectTaskActionProtocolDeclarations();
  const jsonFields = (id) =>
    declarations.find((action) => action.id === id)?.input.fields.find((field) => field.field === "fromFile")?.cli
      ?.jsonFields;
  const submission = jsonFields("submit");
  const review = jsonFields("review");
  if (!submission || !review)
    throw new Error("Task submit and review packet fields must be declared by the Action input.");
  return [
    packetFieldMarkers.start,
    `export const taskSubmissionJsonFields = Object.freeze(${JSON.stringify(submission)} as const);`,
    `export const reviewJsonFields = Object.freeze(${JSON.stringify(review)} as const);`,
    packetFieldMarkers.end,
  ].join("\n");
}

function replaceGeneratedRegion(target, markers, rendered) {
  const source = readFileSync(target, "utf8");
  const start = source.indexOf(markers.start);
  const end = source.indexOf(markers.end, start);
  if (start < 0 || end < 0) throw new Error(`Generated Task Action projection markers are missing in ${target}.`);
  writeFileSync(target, `${source.slice(0, start)}${rendered}${source.slice(end + markers.end.length)}`);
}

export function generateTaskActionProtocolProjection() {
  replaceGeneratedRegion(protocolTarget, protocolMarkers, renderTaskActionProtocolProjection());
  replaceGeneratedRegion(packetFieldsTarget, packetFieldMarkers, renderTaskActionPacketFields());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateTaskActionProtocolProjection();
}
