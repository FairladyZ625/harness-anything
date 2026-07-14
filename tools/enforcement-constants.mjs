import { readFileSync } from "node:fs";
import path from "node:path";

export function getEnforcementConstant(manifest, id) {
  const declarations = manifest.enforcementConstants;
  if (!Array.isArray(declarations)) {
    throw new Error("gate manifest enforcementConstants must be an array");
  }
  const matches = declarations.filter((entry) => entry?.id === id);
  if (matches.length === 0) throw new Error(`gate manifest enforcement constant ${JSON.stringify(id)} is missing`);
  if (matches.length > 1) throw new Error(`gate manifest enforcement constant ${JSON.stringify(id)} is duplicated`);
  return matches[0];
}

export function resolveEnforcementConstant(manifest, id, readAuthority) {
  const declaration = getEnforcementConstant(manifest, id);
  const authority = declaration.authority;
  if (declaration.valueType !== "positive-integer-sequence") {
    throw new Error(`${id} must declare valueType positive-integer-sequence`);
  }
  if (authority?.kind !== "workflow-matrix") {
    throw new Error(`${id} must declare a workflow-matrix authority`);
  }
  if (typeof readAuthority !== "function") {
    throw new Error("resolveEnforcementConstant requires an authority source reader");
  }
  return parseWorkflowMatrix(readAuthority(authority.path), authority, id);
}

export function loadEnforcementConstant(repoRoot, id) {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "tools/gate-manifest.json"), "utf8"));
  return resolveEnforcementConstant(
    manifest,
    id,
    (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8")
  );
}

function parseWorkflowMatrix(workflowText, authority, id) {
  for (const field of ["path", "job", "matrixKey"]) {
    if (typeof authority[field] !== "string" || authority[field].trim() === "") {
      throw new Error(`${id} authority.${field} must be a non-empty string`);
    }
  }

  const lines = workflowText.split(/\r?\n/u);
  const jobs = mappingBlock(lines, "jobs", 0, "rewrite-ci jobs");
  const job = mappingBlock(jobs, authority.job, 2, `rewrite-ci ${authority.job} job`);
  const strategy = mappingBlock(job, "strategy", 4, `${authority.job} strategy`);
  const matrix = mappingBlock(strategy, "matrix", 6, `${authority.job} matrix`);
  const keyPattern = new RegExp(`^ {8}${escapeRegExp(authority.matrixKey)}:`, "u");
  const valueLines = matrix.filter((line) => keyPattern.test(line));
  if (valueLines.length !== 1) {
    throw new Error(`${authority.job} strategy.matrix must declare exactly one ${authority.matrixKey} list`);
  }

  const valuePattern = new RegExp(
    `^ {8}${escapeRegExp(authority.matrixKey)}:\\s*\\[([^\\]]*)\\]\\s*(?:#.*)?$`,
    "u"
  );
  const match = valuePattern.exec(valueLines[0]);
  if (match === null) {
    throw new Error(`${authority.job} strategy.matrix.${authority.matrixKey} must be an inline integer list`);
  }
  const tokens = match[1].split(",").map((entry) => entry.trim());
  if (tokens.length === 0 || tokens.some((entry) => !/^[1-9]\d*$/u.test(entry))) {
    throw new Error(`${authority.job} strategy.matrix.${authority.matrixKey} must contain positive integers`);
  }
  const values = tokens.map(Number);
  const expected = values.map((_, index) => index + 1);
  if (values.some((value, index) => value !== expected[index])) {
    throw new Error(
      `${authority.job} strategy.matrix.${authority.matrixKey} must be contiguous 1..N; got [${values.join(", ")}]`
    );
  }
  return Object.freeze(values);
}

function mappingBlock(lines, key, indent, label) {
  const pattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}:\\s*(?:#.*)?$`, "u");
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => pattern.test(line));
  if (matches.length === 0) throw new Error(`${label} is missing`);
  if (matches.length > 1) throw new Error(`${label} is declared more than once`);

  const start = matches[0].index;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const content = /^( *)\S/u.exec(line);
    if (content !== null && content[1].length <= indent) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
