#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalEventSchemas, serializeCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import { consumeKnownError } from "../../packages/kernel/src/error-consumption.ts";
import { git, repoRoot } from "./git.mjs";

const DEFAULT_REF = "refs/ha/canonical";
const FIXTURE_ROOT = "packages/kernel/fixtures/canonical-events";
const textFields = new Map([
  ["body", "Fixture body"],
  ["description", "Fixture description"],
  ["error", "Fixture error"],
  ["evidence", "Fixture evidence"],
  ["evidenceSource", "Fixture evidence source"],
  ["judgmentOnlyRationale", "Fixture judgment rationale"],
  ["message", "Fixture message"],
  ["mission", "Fixture mission"],
  ["name", "Fixture name"],
  ["prompt", "Fixture prompt"],
  ["question", "Fixture question?"],
  ["rationale", "Fixture rationale"],
  ["statement", "Fixture statement"],
  ["summary", "Fixture summary"],
  ["text", "Fixture text"],
  ["title", "Fixture title"],
  ["whyNot", "Fixture rationale"],
]);

function fixtureDirectory(schema) {
  return schema.replaceAll("/", "-");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function payloadKeySet(payload) {
  const keys = new Set();
  function visit(value, prefix) {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, `${prefix}[]`);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const key of Object.keys(value).sort()) {
      const nested = prefix ? `${prefix}.${key}` : key;
      keys.add(nested);
      visit(value[key], nested);
    }
  }
  visit(payload, "");
  return [...keys].sort();
}

export function canonicalEventShape(event) {
  return {
    schema: event.schema,
    type: event.type,
    payloadKeys: payloadKeySet(event.payload),
  };
}

function shapeIdentity(event) {
  const shape = canonicalEventShape(event);
  return `${shape.schema}\0${shape.type}\0${shape.payloadKeys.join("\0")}`;
}

function scrubPath(value) {
  if (/^(?:[A-Za-z]:[\\/]|\/)/u.test(value)) return `fixtures/${path.basename(value) || "source"}`;
  return value.replace(/(tasks\/task_[^/\s-]+)-[^/\s]+/gu, "$1-fixture");
}

function scrubString(value, key) {
  if (key === "personId" || key === "targetPersonId") return "person-fixture";
  if (key === "displayName") return "Fixture Person";
  if (key === "sessionId" && value.startsWith("transport:")) return "transport:person-fixture";
  if (key === "issuer" && value.startsWith("host:")) return "host:fixture";
  if (key === "subject") return "fixture";
  if (key === "path" || key.endsWith("Path") || key.endsWith("Root")) return scrubPath(value);
  if (textFields.has(key)) return textFields.get(key);
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "fixture@example.invalid")
    .replace(/file:\/\/(?:\/Users|\/home)\/[^/\s]+/gu, "file:///fixtures")
    .replace(/(?:\/Users|\/home)\/[^/\s]+/gu, "fixtures");
}

export function deidentifyCanonicalEvent(value, key = "") {
  if (Array.isArray(value)) return value.map((entry) => deidentifyCanonicalEvent(entry, key));
  if (value === null || typeof value !== "object") return typeof value === "string" ? scrubString(value, key) : value;
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, nested]) => [nestedKey, deidentifyCanonicalEvent(nested, nestedKey)]),
  );
}

function canonicalEventObjects(ledgerRoot, ref) {
  return git(ledgerRoot, ["ls-tree", "-r", "-z", ref, "--", "events"])
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const match = row.match(/^\d+\s+blob\s+([0-9a-f]{40})\t(.+)$/u);
      if (!match) throw new Error(`unexpected git ls-tree row: ${row}`);
      return { oid: match[1], sourcePath: match[2] };
    })
    .filter(({ sourcePath }) => sourcePath.endsWith(".json") && !sourcePath.endsWith("/head.json"));
}

async function visitGitObjects(ledgerRoot, objects, visit) {
  const child = spawn("git", ["cat-file", "--batch"], {
      cwd: ledgerRoot,
      stdio: ["pipe", "pipe", "pipe"],
    }),
    stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(`${objects.map(({ oid }) => oid).join("\n")}\n`);
  let buffer = Buffer.alloc(0),
    header = null,
    index = 0;
  for await (const chunk of child.stdout) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (true) {
      if (header === null) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const fields = buffer.subarray(0, newline).toString("utf8").split(" ");
        if (fields[1] !== "blob" || !/^\d+$/u.test(fields[2] ?? ""))
          throw new Error(`git cat-file did not return a blob: ${fields.join(" ")}`);
        header = { oid: fields[0], size: Number(fields[2]) };
        buffer = buffer.subarray(newline + 1);
      }
      if (buffer.length < header.size + 1) break;
      const object = objects[index];
      if (!object || object.oid !== header.oid) throw new Error(`git cat-file returned ${header.oid} out of order`);
      visit(object, buffer.subarray(0, header.size));
      buffer = buffer.subarray(header.size + 1);
      header = null;
      index += 1;
    }
  }
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) throw new Error(`git cat-file failed: ${Buffer.concat(stderr).toString("utf8").trim()}`);
  if (header !== null || buffer.length !== 0 || index !== objects.length)
    throw new Error(`git cat-file ended after ${index} of ${objects.length} event objects`);
}

export async function sampleCanonicalEventShapes({
  ledgerRoot,
  ref = DEFAULT_REF,
  registrations = canonicalEventSchemas,
}) {
  const schemas = new Map(registrations.map((entry) => [entry.schema, entry])),
    objects = canonicalEventObjects(ledgerRoot, ref),
    samples = new Map(),
    errors = [];
  await visitGitObjects(ledgerRoot, objects, (origin, bytes) => {
    let event;
    try {
      event = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      consumeKnownError(error);
      errors.push(`${origin.sourcePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const registration = schemas.get(event?.schema);
    if (!registration) return;
    const issues = registration.validate(event);
    if (issues.length > 0) {
      errors.push(`${origin.sourcePath}: ${event.schema} rejected canonical history: ${issues.join("; ")}`);
      return;
    }
    const identity = shapeIdentity(event),
      held = samples.get(identity);
    if (
      held === undefined ||
      bytes.byteLength < held.sourceBytes ||
      (bytes.byteLength === held.sourceBytes && origin.sourcePath < held.sourcePath)
    )
      samples.set(identity, {
        ...canonicalEventShape(event),
        event,
        sourceBlob: origin.oid,
        sourceBytes: bytes.byteLength,
        sourcePath: origin.sourcePath,
      });
  });
  if (errors.length > 0) throw new Error(errors.slice(0, 20).join("\n"));
  return [...samples.values()].sort((left, right) =>
    [left.schema, left.type, left.payloadKeys.join("\0"), left.sourcePath]
      .join("\0")
      .localeCompare([right.schema, right.type, right.payloadKeys.join("\0"), right.sourcePath].join("\0")),
  );
}

export function assignSampleFileNames(samples) {
  const firstBySchema = new Set();
  return samples.map((sample) => {
    const first = !firstBySchema.has(sample.schema);
    firstBySchema.add(sample.schema);
    const digest = sha256(`${sample.type}\0${sample.payloadKeys.join("\0")}`).slice(0, 12),
      type = sample.type.replaceAll("_", "-");
    return { ...sample, fileName: first ? "accepted.json" : `accepted-${type}-${digest}.json` };
  });
}

function originsDocument(samples, ref) {
  const rows = samples.map(
    (sample) =>
      `| \`${sample.schema}\` | \`${sample.type}\` | \`${fixtureDirectory(sample.schema)}/${sample.fileName}\` | ` +
      `\`canonical ledger ${ref}:${sample.sourcePath}\` | \`${sample.sourceBlob}\` |`,
  );
  return [
    "# Canonical event fixture origins",
    "",
    "The ledger-derived events below were selected by `tools/gates/sample-canonical-events.mjs` using the",
    "recursive payload-key signature `(schema, type, payload keys)`. Each selected event is de-identified and",
    "reserialized with the production `serializeCanonicalEvent` implementation. Every JSON file in this directory",
    "is protected by `packages/*/fixtures/** -text` in `.gitattributes`.",
    "",
    "| Schema | Event type | Frozen sample | Source | Source blob |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Static/compiler fixtures",
    "",
    "These registered schemas do not occur at the sampled canonical cut and retain their existing fixtures:",
    "",
    "- `agent-entity-event/v1`: de-identified historical `agent_entity_written` event `op_ecb4101d…`.",
    "- `ci-run-observation/v1`: CI artifact ingestion contract fixture.",
    "- `ledger-layout-event/v1`: de-identified canonical layout migration event `op_73c908af…`.",
    "",
  ].join("\n");
}

export function writeCanonicalEventSamples(rootDir, rawSamples, ref = DEFAULT_REF) {
  const samples = assignSampleFileNames(rawSamples),
    fixtureRoot = path.join(rootDir, FIXTURE_ROOT),
    sourceSchemas = new Set(samples.map(({ schema }) => schema)),
    prepared = samples.map((sample) => {
      const event = deidentifyCanonicalEvent(sample.event),
        before = sample.payloadKeys,
        after = payloadKeySet(event.payload),
        registration = canonicalEventSchemas.find(({ schema }) => schema === sample.schema),
        issues = registration?.validate(event) ?? [`unknown schema ${sample.schema}`];
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error(`${sample.schema}/${sample.type}: de-identification changed the payload-key shape`);
      if (issues.length > 0)
        throw new Error(`${sample.schema}/${sample.type}: de-identified sample is invalid: ${issues.join("; ")}`);
      return { ...sample, body: serializeCanonicalEvent(event) };
    });
  for (const schema of sourceSchemas) {
    const directory = path.join(fixtureRoot, fixtureDirectory(schema));
    mkdirSync(directory, { recursive: true });
    for (const name of readdirSync(directory)) if (name.endsWith(".json")) unlinkSync(path.join(directory, name));
  }
  for (const sample of prepared) {
    const destination = path.join(fixtureRoot, fixtureDirectory(sample.schema), sample.fileName);
    writeFileSync(destination, sample.body);
  }
  writeFileSync(path.join(fixtureRoot, "ORIGINS.md"), originsDocument(samples, ref));
  return samples;
}

function parseArgs(argv) {
  const options = { ref: DEFAULT_REF, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--write") options.write = true;
    else if (token === "--ledger" || token === "--ref") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      options[token.slice(2)] = value;
      index += 1;
    } else throw new Error(`unknown argument: ${token}`);
  }
  if (!options.ledger) throw new Error("--ledger <canonical-ledger-root> is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2)),
    rootDir = repoRoot(),
    ledgerRoot = path.resolve(options.ledger);
  if (!existsSync(ledgerRoot)) throw new Error(`canonical ledger does not exist: ${ledgerRoot}`);
  const samples = await sampleCanonicalEventShapes({ ledgerRoot, ref: options.ref }),
    output = options.write ? writeCanonicalEventSamples(rootDir, samples, options.ref) : assignSampleFileNames(samples),
    counts = new Map();
  for (const sample of output) counts.set(sample.schema, (counts.get(sample.schema) ?? 0) + 1);
  console.log(
    `canonical-event-sampler: ${output.length} shapes from ${options.ref}${options.write ? " (written)" : ""}`,
  );
  for (const [schema, count] of [...counts].sort()) console.log(`${schema}\t${count}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
