#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { getEntityKindContract } from "../packages/kernel/src/index.ts";

const target = path.resolve(import.meta.dirname, "../packages/preset/src/preset-command-contract.ts"),
  startMarker = "// task-action-projection:generated:start",
  endMarker = "// task-action-projection:generated:end";

// prettier-ignore
function projectField(field) {
  const jsonSchema = field.cli?.jsonSchema,
    jsonEnums = jsonSchema && Object.fromEntries(jsonSchema.fields.flatMap((nested) =>
      nested.value?.kind === "string" && nested.value.enumRef ? [[nested.field, nested.value.enumRef]] : []));
  return {
    field: field.field, ...(field.type ? { type: field.type } : {}), required: field.required,
    ...(field.enum ? { enum: field.enum } : {}), ...(field.regex ? { regex: field.regex } : {}),
    ...(field.cli ? { cli: { ...Object.fromEntries(Object.entries(field.cli).filter(([key]) => key !== "jsonSchema")),
      ...(jsonSchema ? { jsonFields: jsonSchema.fields.filter(({ required }) => required).map(({ field }) => field),
        jsonAllowedFields: jsonSchema.fields.map(({ field }) => field),
        ...(jsonEnums && Object.keys(jsonEnums).length ? { jsonEnums } : {}) } : {}) } } : {}),
  };
}

// prettier-ignore
export function projectTaskActions() {
  const descriptors = (getEntityKindContract("task")?.actionCatalog?.actions ?? [])
      .filter(({ execution }) => execution?.lifecycle),
    actions = descriptors
    .map(({ id, input, explain, execution }) => ({
      id, input: { schema: "entity-action-input/v1", fields: input.fields.map(projectField),
        exactlyOneOf: input.exactlyOneOf }, explain,
      execution: { ingress: execution.ingress, topology: execution.topology,
        lifecycle: { transitionId: execution.lifecycle.transitionId, commandType: execution.lifecycle.commandType,
          targetIdField: execution.lifecycle.targetIdField, coordination: execution.lifecycle.coordination } },
    }));
  if (actions.length !== 9 || actions.some(({ execution }) => !execution.topology))
    throw new Error("Task Action protocol projection requires create and eight lifecycle descriptors.");
  const create = descriptors.find(({ id }) => id === "create"), start = descriptors.find(({ id }) => id === "start");
  if (!create || !start) throw new Error("Task create/start descriptors are missing.");
  return { writeReceiptFields: start.result.fields.map(({ field }) => field),
    taskCreateResultFields: create.result.fields.map(({ field }) => field), actions };
}

// prettier-ignore
export function renderTaskActionProtocolProjection() {
  const encoded = brotliCompressSync(JSON.stringify(projectTaskActions()), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).toString("base64"),
    chunks = encoded.match(/[\s\S]{1,112}/gu) ?? [];
  return [startMarker,
    `const TASK_ACTION_DESCRIPTOR_PROJECTION_BROTLI = [\n${chunks.map((chunk) => `  "${chunk}",`).join("\n")}\n].join("");`,
    "const taskActionDescriptorProjection = JSON.parse(",
    "  brotliDecompressSync(Buffer.from(TASK_ACTION_DESCRIPTOR_PROJECTION_BROTLI, \"base64\")).toString(\"utf8\"),",
    ") as GeneratedTaskActionProtocolProjection;",
    endMarker].join("\n");
}

function region(source) {
  const start = source.indexOf(startMarker),
    end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Generated Task Action projection markers are missing in ${target}.`);
  return source.slice(start, end + endMarker.length);
}

// prettier-ignore
export function generateTaskActionProtocolProjection(check = false) {
  const source = readFileSync(target, "utf8"), current = region(source), expected = renderTaskActionProtocolProjection();
  if (check && current !== expected) throw new Error("Task Action protocol projection is stale; run its generator.");
  if (!check) writeFileSync(target, source.replace(current, expected));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  generateTaskActionProtocolProjection(process.argv.includes("--check"));
