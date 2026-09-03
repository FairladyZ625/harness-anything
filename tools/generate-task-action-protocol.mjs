#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "prettier";
import prettierConfig from "../prettier.config.mjs";
import { getEntityKindContract } from "../packages/kernel/src/index.ts";

const target = path.resolve(import.meta.dirname, "../packages/preset/src/preset-command-contract.ts"),
  startMarker = "// task-action-projection:generated:start",
  endMarker = "// task-action-projection:generated:end";

function projectField(field) {
  const jsonSchema = field.cli?.jsonSchema,
    defaultError = field.required ? "missing_field" : "invalid_field",
    jsonEnums =
      jsonSchema &&
      Object.fromEntries(
        jsonSchema.fields.flatMap((nested) =>
          nested.value?.kind === "string" && nested.value.enumRef ? [[nested.field, nested.value.enumRef]] : [],
        ),
      );
  return {
    field: field.field,
    ...(field.type && field.type !== "string" ? { type: field.type } : {}),
    ...(field.required ? { required: true } : {}),
    ...(field.enum ? { enum: field.enum } : {}),
    ...(field.regex ? { regex: field.regex } : {}),
    ...(field.cli
      ? {
          cli: {
            ...Object.fromEntries(Object.entries(field.cli).filter(([key]) => key !== "jsonSchema" && key !== "error")),
            ...(field.cli.error.code === defaultError ? {} : { error: field.cli.error.code }),
            ...(jsonSchema
              ? {
                  jsonFields: jsonSchema.fields.filter(({ required }) => required).map(({ field }) => field),
                  jsonAllowedFields: jsonSchema.fields.map(({ field }) => field),
                  ...(jsonEnums && Object.keys(jsonEnums).length ? { jsonEnums } : {}),
                }
              : {}),
          },
        }
      : {}),
  };
}

export function projectTaskActions() {
  const descriptors = (getEntityKindContract("task")?.actionCatalog?.actions ?? []).filter(
      ({ execution }) => execution?.lifecycle,
    ),
    actions = descriptors.map(({ id, input, explain, execution }) => ({
      id,
      input: {
        schema: "entity-action-input/v1",
        fields: input.fields.map(projectField),
        exactlyOneOf: input.exactlyOneOf,
      },
      explain,
      execution: {
        ingress: execution.ingress,
        topology: execution.topology,
        lifecycle: {
          transitionId: execution.lifecycle.transitionId,
          commandType: execution.lifecycle.commandType,
          targetIdField: execution.lifecycle.targetIdField,
          coordination: execution.lifecycle.coordination,
        },
      },
    }));
  if (actions.length !== 9 || actions.some(({ execution }) => !execution.topology))
    throw new Error("Task Action protocol projection requires create and eight lifecycle descriptors.");
  const create = descriptors.find(({ id }) => id === "create"),
    start = descriptors.find(({ id }) => id === "start");
  if (!create || !start) throw new Error("Task create/start descriptors are missing.");
  return {
    writeReceiptFields: start.result.fields.map(({ field }) => field),
    taskCreateResultFields: create.result.fields.map(({ field }) => field),
    actions,
  };
}

function inlineJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
  return `{ ${Object.entries(value)
    .map(([key, item]) => `${JSON.stringify(key)}: ${inlineJson(item)}`)
    .join(", ")} }`;
}

function readableJson(value, depth = 0) {
  const indentation = "  ".repeat(depth),
    inline = inlineJson(value);
  if (indentation.length + inline.length <= 120) return inline;
  const childIndentation = "  ".repeat(depth + 1);
  if (Array.isArray(value))
    return `[\n${value
      .map((item) => `${childIndentation}${readableJson(item, depth + 1)}`)
      .join(",\n")}\n${indentation}]`;
  const entries = Object.entries(value).map(([key, item]) => {
      const prefix = `${JSON.stringify(key)}:`,
        rendered = readableJson(item, depth + 1),
        firstLine = `${childIndentation}${prefix} ${rendered.split("\n", 1)[0]}`;
      if (firstLine.length <= 120) return `${prefix} ${rendered}`;
      const nestedIndentation = "  ".repeat(depth + 2),
        nested = readableJson(item, depth + 2);
      return `${prefix}\n${nestedIndentation}${nested}`;
    }),
    groups = [];
  let current = "";
  for (const entry of entries) {
    const candidate = current ? `${current}, ${entry}` : `${childIndentation}${entry}`;
    if (!entry.includes("\n") && candidate.length <= 120) {
      current = candidate;
      continue;
    }
    if (current) groups.push(current);
    current = "";
    groups.push(`${childIndentation}${entry}`);
  }
  if (current) groups.push(current);
  return `{\n${groups.join(",\n")}\n${indentation}}`;
}

export async function renderTaskActionProtocolProjection() {
  const projection = readableJson(projectTaskActions()),
    rendered = await format(
      [
        startMarker,
        `const taskActionDescriptorProjection = ${projection} as GeneratedTaskActionProtocolProjection;`,
        endMarker,
      ].join("\n"),
      { ...prettierConfig, parser: "typescript" },
    );
  return rendered.trimEnd();
}

function region(source) {
  const start = source.indexOf(startMarker),
    end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Generated Task Action projection markers are missing in ${target}.`);
  return source.slice(start, end + endMarker.length);
}

export async function generateTaskActionProtocolProjection(check = false) {
  const source = readFileSync(target, "utf8"),
    current = region(source),
    expected = await renderTaskActionProtocolProjection();
  if (check && current !== expected) throw new Error("Task Action protocol projection is stale; run its generator.");
  if (!check) writeFileSync(target, source.replace(current, expected));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await generateTaskActionProtocolProjection(process.argv.includes("--check"));
