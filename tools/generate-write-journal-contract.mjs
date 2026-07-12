#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JSONSchema } from "effect";
import { writeOpKinds } from "../packages/kernel/src/domain/write-op-kind.ts";
import { JournalRecordV2Schema } from "../packages/kernel/src/schemas/write-journal.ts";

const root = process.cwd();
const checkOnly = process.argv.includes("--check");
const generated = generatedFiles();
const stale = [];

for (const [relativePath, expected] of generated) {
  const absolutePath = path.join(root, relativePath);
  const actual = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : undefined;
  if (actual === expected) continue;
  if (checkOnly) {
    stale.push(relativePath);
  } else {
    writeFileSync(absolutePath, expected, "utf8");
  }
}

if (stale.length > 0) {
  console.error(`Generated write-journal contract is stale: ${stale.join(", ")}`);
  process.exit(1);
}

console.log(checkOnly
  ? `Generated write-journal contract is fresh (${generated.size} files).`
  : `Generated write-journal contract updated (${generated.size} files).`);

function generatedFiles() {
  const files = new Map();
  const portPath = "packages/kernel/src/ports/write-coordinator.ts";
  files.set(portPath, generatedPortSource(readFileSync(path.join(root, portPath), "utf8")));
  files.set(
    "packages/kernel/schemas/json/write-journal-op.schema.json",
    `${JSON.stringify(generatedJsonSchema(), null, 2)}\n`
  );
  files.set(
    "packages/kernel/fixtures/schemas/write-journal-op/valid.json",
    `${JSON.stringify(validFixture(), null, 2)}\n`
  );
  files.set(
    "packages/kernel/fixtures/schemas/write-journal-op/write-op-kinds.json",
    `${JSON.stringify(writeOpKinds, null, 2)}\n`
  );
  return files;
}

function generatedPortSource(source) {
  const start = "// BEGIN GENERATED WRITE-ROAD KIND DISCOVERY";
  const end = "// END GENERATED WRITE-ROAD KIND DISCOVERY";
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) throw new Error("generated write-road marker block missing");
  const union = writeOpKinds.map((kind) => `  | ${JSON.stringify(kind)}`).join("\n");
  const block = `${start}\n// Generated for the existing write-road AST inventory. Do not edit.\ntype GeneratedWriteRoadWriteOpKind =\n${union};\ntrue satisfies [GeneratedWriteRoadWriteOpKind] extends [WriteOpKind]\n  ? ([WriteOpKind] extends [GeneratedWriteRoadWriteOpKind] ? true : never)\n  : never;\n${end}`;
  return `${source.slice(0, startIndex)}${block}${source.slice(endIndex + end.length)}`;
}

function generatedJsonSchema() {
  const schema = JSONSchema.make(JournalRecordV2Schema);
  return {
    ...schema,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://harness-anything.dev/schemas/write-journal-op.schema.json",
    "x-harness-schema-id": "write-journal-op",
    title: "Write Journal Op v2",
    allOf: [
      {
        if: {
          properties: {
            actor: {
              properties: { executor: { type: "null" } },
              required: ["executor"]
            }
          }
        },
        then: {
          properties: { executorSource: { const: "none" } }
        },
        else: {
          properties: { executorSource: { const: "client-asserted" } }
        }
      }
    ]
  };
}

function validFixture() {
  return {
    schema: "write-journal/v2",
    opId: "op-2026-07-12-001",
    entityId: "task/task_01KXAWX9FCZARZ6W6PT670Q0WR",
    kind: writeOpKinds[0],
    actor: {
      principal: { kind: "person", personId: "person_zeyu" },
      executor: { kind: "agent", id: "codex" }
    },
    principalSource: {
      kind: "local-configured",
      authority: "harness.yaml",
      authoritySha256: "sha256:fixture"
    },
    executorSource: "client-asserted",
    at: "2026-07-12T00:01:00.000Z",
    payload: { payloadHash: "sha256:fixture" }
  };
}
