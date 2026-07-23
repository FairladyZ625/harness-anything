#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { discoverWorkspaceSourceRoots } from "./workspace-packages.mjs";
import { discoverWriteSurfaces } from "./write-road-discovery.mjs";

const root = process.cwd();
const registryPath = path.resolve(root, process.env.HARNESS_WRITE_ROAD_REGISTRY ?? "tools/write-road-registry.json");
const sourceRoots = [...discoverWorkspaceSourceRoots(root), "tools"];

const registry = loadRegistry();
const rows = registry.rows;
const discoveries = discoverWriteSurfaces();
const findings = [];

validateRegistryShape();
checkIntentCompilerCriterion();
checkCoverage();
checkStaleRegistryEntries();
checkInventoryReconciliation();
checkWritePointRatchet();

if (findings.length > 0) {
  console.error("Write-road registry check failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  const writePoints = discoveries.filter((item) => item.type === "direct-write");
  const omissionDebt = rows.flatMap((row) => asArray(row.directWrites)).filter((entry) => entry.classification === "omission-debt").length;
  const previous = previousWritePointCounts() ?? {
    coverage: registry.writePointRatchet.previousCoverage,
    omissionDebt: registry.writePointRatchet.previousOmissionDebt
  };
  console.log(`[write-road-coverage] current=${writePoints.length} previous=${previous.coverage} delta=${writePoints.length - previous.coverage}`);
  console.log(`[write-road-ratchet] current=${omissionDebt} previous=${previous.omissionDebt} delta=${omissionDebt - previous.omissionDebt}`);
  const intentItems = rows.flatMap((row) => asArray(row.intentCompilers));
  console.log(`[intent-compiler-criterion] unified=${intentItems.filter((item) => item.parity === "unified").length} parity-debt=${intentItems.filter((item) => item.parity === "parity-debt").length} single-surface-debt=${intentItems.filter((item) => item.parity === "single-surface-debt").length} single-entry=${intentItems.filter((item) => item.parity === "single-entry").length} unknown=${intentItems.filter((item) => item.parity === "unknown").length}`);
  console.log(`Write-road registry check passed (${sourceRoots.length} production source root(s), ${rows.length} row(s), ${discoveries.length} discovered write surface(s)).`);
}

function loadRegistry() {
  const raw = readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!isObject(parsed)) fail("registry root must be a JSON object");
  if (parsed.schema !== "harness-anything/write-road-registry/v1") {
    fail("registry schema must be harness-anything/write-road-registry/v1");
  }
  if (!Array.isArray(parsed.rows)) fail("registry.rows must be an array");
  return parsed;
}

function validateRegistryShape() {
  const ids = new Set();
  const writePointKeys = new Set();
  for (const [index, row] of rows.entries()) {
    const label = `rows[${index}]`;
    if (!isObject(row)) record(`${label} must be an object`);
    if (typeof row.id !== "string" || row.id.trim() === "") record(`${label}.id must be non-empty`);
    if (ids.has(row.id)) record(`${label}.id duplicates ${row.id}`);
    ids.add(row.id);
    if (!["A", "B", "C", "D"].includes(row.road)) record(`${row.id}: road must be A, B, C, or D`);
    if (!Array.isArray(row.sourceInventoryRows) || row.sourceInventoryRows.length === 0) record(`${row.id}: sourceInventoryRows must be non-empty`);
    if (!isObject(row.channel)) record(`${row.id}: channel must declare pathClass and zoneClass`);
    if (isObject(row.channel)) {
      if (typeof row.channel.pathClass !== "string" || row.channel.pathClass.trim() === "") record(`${row.id}: channel.pathClass must be non-empty`);
      if (typeof row.channel.zoneClass !== "string" || row.channel.zoneClass.trim() === "") record(`${row.id}: channel.zoneClass must be non-empty`);
    }
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) record(`${row.id}: evidence must be non-empty`);
    for (const evidence of row.evidence ?? []) {
      if (typeof evidence !== "string" || !evidence.includes(":")) {
        record(`${row.id}: evidence entry must be file:line anchored: ${String(evidence)}`);
        continue;
      }
      const evidencePath = evidence.split(":")[0];
      if (!existsSync(path.join(root, evidencePath))) record(`${row.id}: evidence path does not exist: ${evidencePath}`);
    }
    for (const [writeIndex, entry] of asArray(row.directWrites).entries()) {
      const entryLabel = `${row.id}.directWrites[${writeIndex}]`;
      if (!isObject(entry)) {
        record(`${entryLabel} must be an object`);
        continue;
      }
      if (typeof entry.key !== "string" || entry.key.trim() === "") record(`${entryLabel}.key must be non-empty`);
      if (writePointKeys.has(entry.key)) record(`${entryLabel}.key duplicates ${entry.key}`);
      writePointKeys.add(entry.key);
      if (typeof entry.owner !== "string" || entry.owner.trim() === "") record(`${entryLabel}.owner must be non-empty`);
      if (!["coordinator-owned", "design-exemption", "omission-debt"].includes(entry.classification)) {
        record(`${entryLabel}.classification must be coordinator-owned, design-exemption, or omission-debt`);
      }
      if (typeof entry.ref !== "string" || !/^(?:ADR-\d{4}|dec_[A-Za-z0-9_]+|task_[A-Z0-9]+)/u.test(entry.ref)) {
        record(`${entryLabel}.ref must cite an ADR, decision, or task id`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) record(`${entryLabel}.reason must explain the governance basis`);
    }
    if (row.leaseRequired === true && !String(row.bearing ?? "").startsWith("task-")) {
      record(`${row.id}: leaseRequired rows must declare task-* bearing`);
    }
  }
}

function checkIntentCompilerCriterion() {
  const criterion = registry.intentCompilerCriterion;
  const authoredFields = ["cliActions", "apiRoutes", "guiBridgeMethods"];
  if (!isObject(criterion)) {
    record("intentCompilerCriterion must declare authored surface fields and the structural not-applicable rule");
    return;
  }
  if (JSON.stringify(criterion.authoredSurfaceFields) !== JSON.stringify(authoredFields)) {
    record(`intentCompilerCriterion.authoredSurfaceFields must be ${authoredFields.join(", ")}`);
  }
  if (criterion.notApplicableWhen !== "no-authored-ingress-surfaces") {
    record("intentCompilerCriterion.notApplicableWhen must be no-authored-ingress-surfaces");
  }

  const discoveredSurfaces = new Set();
  for (const discovery of discoveries) {
    const surface = authoredSurfaceForDiscovery(discovery);
    if (surface) discoveredSurfaces.add(surface);
  }

  const coveredSurfaces = new Map();
  const selectors = new Set();
  for (const row of rows) {
    const rowSurfaces = new Set(authoredFields.flatMap((field) => asArray(row[field]).map((value) => `${field}:${value}`)));
    const items = asArray(row.intentCompilers);
    if (rowSurfaces.size === 0 && items.length > 0) {
      record(`${row.id}: non-authored row is not-applicable and cannot declare intentCompilers`);
    }
    for (const [itemIndex, item] of items.entries()) {
      const label = `${row.id}.intentCompilers[${itemIndex}]`;
      if (!isObject(item)) {
        record(`${label} must be an object`);
        continue;
      }
      if (typeof item.selector !== "string" || item.selector.trim() === "") {
        record(`${label}.selector must be non-empty`);
      } else if (selectors.has(item.selector)) {
        record(`${label}.selector duplicates ${item.selector}`);
      } else {
        selectors.add(item.selector);
      }
      const itemSurfaces = authoredFields.flatMap((field) => asArray(item.surfaces?.[field]).map((value) => `${field}:${value}`));
      if (itemSurfaces.length === 0) record(`${label}.surfaces must select at least one authored ingress surface`);
      const expectedSelector = sourceDerivedSelector(item.surfaces);
      if (expectedSelector && item.selector !== expectedSelector) {
        record(`${label}.selector must be source-derived as ${expectedSelector}`);
      }
      if (!itemSurfaces.some((surface) => rowSurfaces.has(surface))) {
        record(`${label} must be owned by a row that declares at least one selected surface`);
      }
      for (const surface of itemSurfaces) {
        if (!discoveredSurfaces.has(surface)) record(`${label}: stale or non-authored surface ${surface}`);
        const previous = coveredSurfaces.get(surface);
        if (previous) record(`${label}: authored surface ${surface} is already owned by ${previous}`);
        else coveredSurfaces.set(surface, item.selector);
      }
      validateIntentParity(item, label);
    }
  }

  for (const surface of [...discoveredSurfaces].sort()) {
    if (!coveredSurfaces.has(surface)) record(`${surface}: authored ingress surface has no intent compiler criterion item`);
  }
}

function validateIntentParity(item, label) {
  if (!["unified", "parity-debt", "single-surface-debt", "single-entry", "unknown"].includes(item.parity)) {
    record(`${label}.parity must be unified, parity-debt, single-surface-debt, single-entry, or unknown`);
    return;
  }
  if (item.parity === "unknown") {
    if (typeof item.reason !== "string" || item.reason.trim().length < 20) {
      record(`${label}: unknown must include a specific reason`);
    }
    if (asArray(item.compilers).length > 0) record(`${label}: unknown cannot declare verified compilers`);
    return;
  }

  const compilers = asArray(item.compilers);
  if (item.parity === "single-entry") {
    if (compilers.length !== 1) record(`${label}: single-entry must declare exactly one entry compiler`);
  } else if (compilers.length < 2) {
    record(`${label}: ${item.parity} must declare at least two entry compilers`);
  }
  const entries = new Set();
  const refs = new Set();
  for (const [compilerIndex, compiler] of compilers.entries()) {
    const compilerLabel = `${label}.compilers[${compilerIndex}]`;
    if (!isObject(compiler)) {
      record(`${compilerLabel} must be an object`);
      continue;
    }
    if (typeof compiler.entry !== "string" || compiler.entry.trim() === "") record(`${compilerLabel}.entry must be non-empty`);
    else if (entries.has(compiler.entry)) record(`${compilerLabel}.entry duplicates ${compiler.entry}`);
    else entries.add(compiler.entry);
    if (typeof compiler.ref !== "string" || !compiler.ref.includes("#")) {
      record(`${compilerLabel}.ref must be path#symbol`);
      continue;
    }
    refs.add(compiler.ref);
    const [refPath, symbol] = compiler.ref.split("#");
    const absolute = path.join(root, refPath);
    if (!existsSync(absolute)) record(`${compilerLabel}.ref path does not exist: ${refPath}`);
    else if (!new RegExp(`\\b${escapeRegExp(symbol)}\\b`, "u").test(readFileSync(absolute, "utf8"))) {
      record(`${compilerLabel}.ref symbol does not exist: ${compiler.ref}`);
    }
  }
  if (item.parity === "unified" && refs.size !== 1) {
    record(`${label}: unified entry compilers must resolve to one materializer ref`);
  }
  const surfaceCount = ["cliActions", "apiRoutes", "guiBridgeMethods"]
    .reduce((count, field) => count + asArray(item.surfaces?.[field]).length, 0);
  if (item.parity === "parity-debt") {
    if (surfaceCount < 2) record(`${label}: parity-debt must describe one intent with multiple ingress surfaces`);
    if (refs.size < 2) record(`${label}: parity-debt must identify multiple materializer refs`);
    if (typeof item.owner !== "string" || item.owner.trim() === "") record(`${label}: parity-debt must include owner`);
    if (typeof item.sunset !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(item.sunset)) {
      record(`${label}: parity-debt must include sunset as YYYY-MM-DD`);
    }
  }
  if (item.parity === "single-surface-debt") {
    if (surfaceCount !== 1) record(`${label}: single-surface-debt must describe exactly one authored ingress surface`);
    if (refs.size < 2) record(`${label}: single-surface-debt must identify multiple materializer refs`);
    if (typeof item.owner !== "string" || item.owner.trim() === "") record(`${label}: single-surface-debt must include owner`);
    if (typeof item.sunset !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(item.sunset)) {
      record(`${label}: single-surface-debt must include sunset as YYYY-MM-DD`);
    }
  }
  if (item.parity === "single-entry") {
    if (surfaceCount !== 1) record(`${label}: single-entry must describe exactly one authored ingress surface`);
    if (typeof item.reviewWhen !== "string"
      || item.reviewWhen.trim().length < 20
      || !/\bunknown\b/iu.test(item.reviewWhen)
      || !/\b(?:entry|ingress|surface)\b/iu.test(item.reviewWhen)) {
      record(`${label}: single-entry must include a specific reviewWhen trigger`);
    }
  }
}

function sourceDerivedSelector(surfaces) {
  const cliAction = [...asArray(surfaces?.cliActions)].sort()[0];
  if (cliAction) return cliAction;
  const apiRoute = [...asArray(surfaces?.apiRoutes)].sort()[0];
  if (apiRoute) return `api:${apiRoute}`;
  const guiBridgeMethod = [...asArray(surfaces?.guiBridgeMethods)].sort()[0];
  return guiBridgeMethod ? `gui:${guiBridgeMethod}` : undefined;
}

function authoredSurfaceForDiscovery(discovery) {
  if (discovery.type === "daemon-cli-action") return `cliActions:${discovery.cliAction}`;
  if (discovery.type === "api-route") return `apiRoutes:${discovery.apiRoute}`;
  if (discovery.type === "gui-bridge-method") return `guiBridgeMethods:${discovery.guiBridgeMethod}`;
  return undefined;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function checkCoverage() {
  for (const discovery of discoveries) {
    if (!rows.some((row) => covers(row, discovery))) {
      record(`${discovery.key}: no write-road registry row covers ${discovery.message}`);
    }
  }
}

function checkStaleRegistryEntries() {
  const checks = [
    ["writeKinds", "write-op-kind", "writeOpKind"],
    ["machineArtifactBoundaries", "machine-artifact-boundary", "machineArtifactBoundary"],
    ["cliActions", "daemon-cli-action", "cliAction"],
    ["apiRoutes", "api-route", "apiRoute"],
    ["guiBridgeMethods", "gui-bridge-method", "guiBridgeMethod"],
    ["presetWriteScopes", "preset-write-scope", "presetWriteScope"],
    ["presetProduces", "preset-produce-scope", "presetProduceScope"]
  ];
  for (const row of rows) {
    for (const [field, type, property] of checks) {
      for (const value of asArray(row[field])) {
        if (!discoveries.some((discovery) => discovery.type === type && discovery[property] === value)) {
          record(`${row.id}: stale ${field} entry ${value}`);
        }
      }
    }
    for (const file of asArray(row.callsiteFiles)) {
      if (!discoveries.some((discovery) => discovery.type === "coordinator-callsite" && discovery.file === file)) {
        record(`${row.id}: stale callsiteFiles entry ${file}`);
      }
    }
    for (const entry of asArray(row.directWrites)) {
      if (!isObject(entry) || typeof entry.key !== "string") {
        record(`${row.id}: directWrites entries must include key`);
        continue;
      }
      if (!discoveries.some((discovery) => discovery.type === "direct-write" && discovery.key === entry.key)) {
        record(`${row.id}: stale directWrites entry ${entry.key}`);
      }
    }
  }
}

function checkInventoryReconciliation() {
  const covered = new Set();
  for (const row of rows) {
    for (const item of row.sourceInventoryRows) covered.add(item);
  }
  const declaredRowCount = registry.rowCountReconciliation?.registryRows;
  if (declaredRowCount !== undefined && declaredRowCount !== rows.length) {
    record(`rowCountReconciliation.registryRows is ${declaredRowCount}, but registry has ${rows.length} row(s)`);
  }
  for (let index = 1; index <= 26; index += 1) {
    if (!covered.has(index)) record(`source inventory row ${index} is not covered by registry rows`);
  }
  for (const item of [...covered].sort((a, b) => a - b)) {
    if (!Number.isInteger(item) || item < 1 || item > 26) record(`registry cites invalid sourceInventoryRows entry ${item}`);
  }
}

function checkWritePointRatchet() {
  if (!isObject(registry.writePointRatchet)) {
    record("writePointRatchet must declare previousCoverage and previousOmissionDebt");
    return;
  }
  const previousCoverage = registry.writePointRatchet.previousCoverage;
  const previousOmissionDebt = registry.writePointRatchet.previousOmissionDebt;
  if (!Number.isInteger(previousCoverage) || previousCoverage < 0) record("writePointRatchet.previousCoverage must be a non-negative integer");
  if (!Number.isInteger(previousOmissionDebt) || previousOmissionDebt < 0) record("writePointRatchet.previousOmissionDebt must be a non-negative integer");
  const omissionDebt = rows.flatMap((row) => asArray(row.directWrites)).filter((entry) => entry.classification === "omission-debt").length;
  const comparison = previousWritePointCounts()?.omissionDebt ?? previousOmissionDebt;
  if (Number.isInteger(comparison) && omissionDebt > comparison) {
    record(`write-point omission debt grew from ${comparison} to ${omissionDebt}`);
  }
}

function previousWritePointCounts() {
  try {
    const raw = execFileSync("git", ["show", "HEAD^:tools/write-road-registry.json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const previous = JSON.parse(raw);
    if (!isObject(previous) || !Array.isArray(previous.rows)) return undefined;
    const entries = previous.rows.flatMap((row) => asArray(row.directWrites));
    if (entries.every((entry) => isObject(entry) && typeof entry.key === "string")) {
      return {
        coverage: entries.length,
        omissionDebt: entries.filter((entry) => entry.classification === "omission-debt").length
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function covers(row, discovery) {
  if (discovery.type === "write-op-kind") return asArray(row.writeKinds).includes(discovery.writeOpKind);
  if (discovery.type === "machine-artifact-boundary") return asArray(row.machineArtifactBoundaries).includes(discovery.machineArtifactBoundary);
  if (discovery.type === "coordinator-callsite") return asArray(row.callsiteFiles).includes(discovery.file) || asArray(row.writeKinds).includes(discovery.writeOpKind);
  if (discovery.type === "direct-write") {
    return asArray(row.directWrites).some((entry) => isObject(entry) && entry.key === discovery.key);
  }
  if (discovery.type === "daemon-cli-action") return asArray(row.cliActions).includes(discovery.cliAction);
  if (discovery.type === "api-route") return asArray(row.apiRoutes).includes(discovery.apiRoute);
  if (discovery.type === "gui-bridge-method") return asArray(row.guiBridgeMethods).includes(discovery.guiBridgeMethod);
  if (discovery.type === "preset-write-scope") return asArray(row.presetWriteScopes).includes(discovery.presetWriteScope);
  if (discovery.type === "preset-produce-scope") return asArray(row.presetProduces).includes(discovery.presetProduceScope);
  return false;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(message) {
  findings.push(message);
}

function fail(message) {
  console.error(`Write-road registry check failed: ${message}`);
  process.exit(2);
}
