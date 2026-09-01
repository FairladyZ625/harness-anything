#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decisionStates } from "../packages/kernel/src/domain/decision-event-types.ts";
import { factLivenessStates } from "../packages/kernel/src/domain/fact-liveness.ts";
import { domainStatuses } from "../packages/kernel/src/domain/lifecycle-status.ts";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "packages/daemon/src/protocol/daemon-protocol-vocabulary.ts");
const markers = {
  start: "// daemon-status-vocabulary:generated:start",
  end: "// daemon-status-vocabulary:generated:end",
};

const projections = [
  ["taskStatusWords", domainStatuses],
  ["decisionStateWords", decisionStates],
  ["factLivenessWords", factLivenessStates],
];

export function renderDaemonStatusVocabularyProjection() {
  return [
    markers.start,
    ...projections.flatMap(([name, words]) => [...renderDeclaration(name, words), ""]),
    markers.end,
  ].join("\n");
}

function renderDeclaration(name, words) {
  const inline = `export const ${name} = [${words.map((word) => JSON.stringify(word)).join(", ")}] as const;`;
  return inline.length <= 120
    ? [inline]
    : [`export const ${name} = [`, ...words.map((word) => `  ${JSON.stringify(word)},`), "] as const;"];
}

export function normalizeProjectionLineEndings(source) {
  return source.replaceAll("\r\n", "\n");
}

function generatedRegion(source, sourcePath = target) {
  const start = source.indexOf(markers.start),
    end = source.indexOf(markers.end, start);
  if (start < 0 || end < 0) throw new Error(`Generated daemon status vocabulary markers are missing in ${sourcePath}.`);
  return source.slice(start, end + markers.end.length);
}

export function daemonStatusVocabularyProjectionFinding(source) {
  const current = generatedRegion(source),
    expected = renderDaemonStatusVocabularyProjection();
  return normalizeProjectionLineEndings(current) === normalizeProjectionLineEndings(expected)
    ? null
    : "Generated daemon status vocabulary is stale; run tools/generate-daemon-status-vocabulary.mjs.";
}

export function checkDaemonStatusVocabularyProjection() {
  const finding = daemonStatusVocabularyProjectionFinding(readFileSync(target, "utf8"));
  if (finding) throw new Error(finding);
}

export function generateDaemonStatusVocabularyProjection() {
  const source = readFileSync(target, "utf8"),
    current = generatedRegion(source),
    start = source.indexOf(current);
  writeFileSync(
    target,
    `${source.slice(0, start)}${renderDaemonStatusVocabularyProjection()}${source.slice(start + current.length)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes("--check")) checkDaemonStatusVocabularyProjection();
  else generateDaemonStatusVocabularyProjection();
}
