#!/usr/bin/env node
/**
 * Cross-aggregate judgment single-definition ratchet (DDD slice 3).
 * Authority: dec_399F48E3547D831F1199F51E84 CH1 and the DDD blueprint;
 * dec_6B963E9B83AE4AC73FB0A61E81 CH2 for the projected fact `invalidated` field.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { git, listWorktreeFiles } from "./gates/git.mjs";

const DISPATCH_OBSERVATION_BASELINE = "tools/gate-allowlists/dispatch-lifecycle-observation.json";

const judgments = Object.freeze([
  {
    id: "closeoutReadiness",
    symbol: "closeoutReadiness",
    canonical: "packages/kernel/src/domain/closeout-readiness.ts",
    declaration: "function",
  },
  {
    id: "factLiveness",
    symbol: "factLiveness",
    canonical: "packages/kernel/src/domain/fact-liveness.ts",
    declaration: "function",
  },
  {
    id: "coverageOf",
    symbol: "coverageOf",
    canonical: "packages/kernel/src/domain/decision-coverage.ts",
    declaration: "function",
  },
  {
    id: "blockingOf",
    symbol: "blockingOf",
    canonical: "packages/kernel/src/domain/task-blocking.ts",
    declaration: "function",
  },
  {
    id: "startability",
    symbol: "canStartExecution",
    canonical: "packages/kernel/src/domain/task-lifecycle-command-transitions.ts",
    declaration: "function",
  },
  {
    id: "queryPayloadValidation",
    symbol: "queryPayloadValidation",
    canonical: "packages/kernel/src/domain/query-payload-validation.ts",
    declaration: "function",
  },
  {
    id: "statusVocabulary",
    symbol: "statusVocabularies",
    canonical: "packages/kernel/src/domain/status-vocabulary.ts",
    declaration: "const",
  },
  {
    id: "closeoutBilingualDelivery",
    symbol: "missingChineseCloseoutSections",
    canonical: "packages/kernel/src/domain/transition-document-readiness.ts",
    declaration: "function",
  },
]);
const requiredConsumers = new Map([
  ["packages/kernel/src/domain/task-lifecycle-review-transitions.ts", "closeoutReadiness("],
  ["packages/kernel/src/domain/completion-readiness.ts", "closeoutReadiness("],
  ["packages/storage/src/projection/sqlite-task-source.ts", "domainCloseoutReadiness("],
  ["packages/storage/src/projection/fact-event-projection.ts", "factLiveness("],
  ["packages/storage/src/projection/decision-projection-coverage.ts#coverage", "coverageOf("],
  ["packages/storage/src/projection/cold-rebuild-source.ts#liveness", "factLiveness("],
  ["packages/daemon/src/repo-cell.ts#closeout", "closeoutReadiness("],
  ["packages/daemon/src/repo-cell.ts#blocking", "blockingOf("],
  ["packages/kernel/src/domain/task-action-capability.ts", "canStartExecution("],
  [
    "packages/daemon/src/protocol/daemon-protocol-vocabulary.ts#generated-start",
    "// daemon-status-vocabulary:generated:start",
  ],
  ["packages/daemon/src/protocol/daemon-protocol-vocabulary.ts#task", "export const taskStatusWords = ["],
  ["packages/daemon/src/protocol/daemon-protocol-vocabulary.ts#decision", "export const decisionStateWords = ["],
  ["packages/daemon/src/protocol/daemon-protocol-vocabulary.ts#fact", "export const factLivenessWords = ["],
  ["tools/gates/render-task-pr-body.mjs", "missingChineseCloseoutSections("],
  ["packages/daemon/src/repo-cell-submit.ts", "missingChineseCloseoutSections("],
]);

export function checkDomainJudgmentSingleDefinition(root = process.cwd()) {
  const findings = [],
    files = listWorktreeFiles(root, ["packages", "tools/gates"]).filter(
      (rel) =>
        /\.(?:ts|tsx|mts|js|jsx|mjs)$/u.test(rel) &&
        !/(?:^|\/)(?:test|tests|fixtures)\//u.test(rel) &&
        !/\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(rel),
    );
  for (const judgment of judgments) {
    const definition =
        judgment.declaration === "function"
          ? new RegExp(`(?:export\\s+)?function\\s+${judgment.symbol}\\s*\\(`, "gu")
          : new RegExp(`(?:export\\s+)?const\\s+${judgment.symbol}(?:\\s*:[^=]+)?\\s*=`, "gu"),
      hits = [];
    for (const rel of files) {
      const count = [...readFileSync(path.join(root, rel), "utf8").matchAll(definition)].length;
      for (let index = 0; index < count; index += 1) hits.push(rel);
    }
    if (hits.length !== 1 || hits[0] !== judgment.canonical)
      findings.push(
        `${judgment.id}: expected one definition of ${judgment.symbol} at ${judgment.canonical}; ` +
          `found ${hits.length ? hits.join(", ") : "none"}`,
      );
  }
  for (const [key, call] of requiredConsumers) {
    const file = key.split("#")[0],
      body = read(root, file);
    if (!body.includes(call)) findings.push(`${file}: must consume named domain judgment ${call.slice(0, -1)}`);
  }
  const projectionBodies = files
    .filter((file) => /packages\/kernel\/src\/projection\//u.test(file))
    .map((file) => [file, readFileSync(path.join(root, file), "utf8")]);
  for (const [file, body] of projectionBodies) {
    if (/(?:EXISTS|NOT\s+EXISTS)[\s\S]{0,240}supersedes-fact/iu.test(body))
      findings.push(`${file}: SQL infers Fact liveness instead of calling factLiveness`);
    if (/function\s+(?:coveragePath|firstFact|standingPolicy)\s*\(/u.test(body))
      findings.push(`${file}: carries a second Decision coverage algorithm`);
  }
  const guiBodies = files
    .filter((file) => /^packages\/gui\//u.test(file))
    .map((file) => [file, readFileSync(path.join(root, file), "utf8")]);
  const taskAdapter = read(root, "packages/gui/src/renderer/task-adapter.ts"),
    triadic = read(root, "packages/gui/src/renderer/triadic-data.ts"),
    guiTriadic = read(root, "packages/gui/src/renderer/model/triadic.ts");
  const daemonDispatch = read(root, "packages/daemon/src/repo-cell-action-dispatch.ts"),
    taskSurface = read(root, "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts");
  if (/function\s+(?:deriveBlocking|closeoutReadiness|gateResults)\s*\(/u.test(taskAdapter))
    findings.push("packages/gui/src/renderer/task-adapter.ts: recomputes closeout or blocking judgment");
  if (!/invalidated:\s*row\.invalidated\b/u.test(triadic))
    findings.push(
      "packages/gui/src/renderer/triadic-data.ts: must consume the projected fact `invalidated` field (row.invalidated)",
    );
  for (const [file, body] of guiBodies)
    if (/===\s*"superseded_fact"|"superseded_fact"\s*===/u.test(body))
      findings.push(`${file}: compares the fact liveness word instead of reading the projected invalidated field`);
  if (/function\s+coverageOf\s*\(/u.test(guiTriadic))
    findings.push("packages/gui/src/renderer/model/triadic.ts: carries a renderer coverage algorithm");
  if (
    /preview\s*&&\s*!current\.snapshot\.task|preview\s*&&\s*current\.snapshot\.lease|isTerminalStatus\(current\.snapshot\.task\.status\)/u.test(
      daemonDispatch,
    )
  )
    findings.push("packages/daemon/src/repo-cell-action-dispatch.ts: carries a second Task startability preview");
  if (/(?:requiredWhen|allowedWhen):\s*\{\s*field:\s*"status"/su.test(taskSurface))
    findings.push(
      "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts: projects cancellation eligibility into the CLI",
    );
  const baseline = readDispatchObservationBaseline(root),
    dispatchSites = scanDispatchLifecycleObservationSites(root),
    priorBaseline = readPreviousDispatchObservationEntries(root);
  findings.push(...checkDispatchLifecycleObservationSites(dispatchSites, baseline, priorBaseline));
  return findings;
}

export function scanDispatchLifecycleObservationSites(root = process.cwd()) {
  const sites = [],
    files = listWorktreeFiles(root, ["packages"]).filter(
      (rel) =>
        /\.(?:ts|tsx|mts|js|jsx|mjs)$/u.test(rel) &&
        /(?:^|\/)src\//u.test(rel) &&
        !/(?:^|\/)(?:test|tests|fixtures)\//u.test(rel) &&
        !/\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(rel),
    );
  for (const rel of files) {
    const body = readFileSync(path.join(root, rel), "utf8"),
      source = ts.createSourceFile(rel, body, ts.ScriptTarget.Latest, true, scriptKind(rel));
    const add = (node, symbol, kind) => {
      const fingerprint = createHash("sha256")
        .update(`${rel}\0${symbol}\0${kind}\0${node.getText(source).replace(/\s+/gu, " ").trim()}`)
        .digest("hex");
      sites.push({ path: rel, symbol, kind, fingerprint });
    };
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "runtimePidIsAlive" &&
        !insideProcessObservedPayload(node)
      )
        add(judgmentContextNode(node), enclosingSymbol(node), "runtimePidIsAlive");
      if (ts.isReturnStatement(node) && node.expression) {
        const text = node.expression.getText(source),
          fnText = enclosingFunction(node)?.getText(source) ?? text;
        if (/(?:process[_-]lost|processLost)/u.test(text) && /(?:terminal|outcome|closed)/iu.test(`${text} ${fnText}`))
          add(node, enclosingSymbol(node), "process-lost-terminal-return");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort(compareObservationSite);
}

export function checkDispatchLifecycleObservationSites(sites, baseline, priorBaseline = null) {
  const findings = [],
    baselineEntries = Array.isArray(baseline?.entries) ? baseline.entries : [],
    allowed = countEntries(baselineEntries);
  if (baseline?.schema !== "dispatch-lifecycle-observation-baseline/v1")
    findings.push(`${DISPATCH_OBSERVATION_BASELINE}: invalid or missing dispatch observation baseline`);
  for (const site of sites) {
    const key = observationKey(site),
      remaining = allowed.get(key) ?? 0;
    if (remaining === 0)
      findings.push(
        `${site.path}#${site.symbol}: new ${site.kind} judgment (${site.fingerprint}); remove the business judgment or obtain a governance decision`,
      );
    else allowed.set(key, remaining - 1);
  }
  for (const [key, count] of allowed)
    if (count > 0) findings.push(`${DISPATCH_OBSERVATION_BASELINE}: stale baseline entry should be removed: ${key}`);
  if (priorBaseline !== null) {
    const prior = countEntries(priorBaseline),
      current = countEntries(baselineEntries);
    for (const [key, count] of current)
      if (count > (prior.get(key) ?? 0))
        findings.push(`${DISPATCH_OBSERVATION_BASELINE}: baseline may only shrink; added ${key}`);
  }
  return findings;
}

function countEntries(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const key = observationKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function readDispatchObservationBaseline(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, DISPATCH_OBSERVATION_BASELINE), "utf8"));
  } catch {
    return null;
  }
}

function readPreviousDispatchObservationEntries(root) {
  try {
    const base = process.env.PR_BASE_SHA ?? "origin/main",
      body = git(root, ["show", `${base}:${DISPATCH_OBSERVATION_BASELINE}`]),
      previous = JSON.parse(body);
    return previous?.schema === "dispatch-lifecycle-observation-baseline/v1" && Array.isArray(previous.entries)
      ? previous.entries
      : [];
  } catch {
    return null;
  }
}

function insideProcessObservedPayload(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isObjectLiteralExpression(parent)) {
      const type = parent.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          propertyName(property.name) === "type" &&
          ts.isStringLiteralLike(property.initializer),
      );
      if (type && ts.isPropertyAssignment(type) && ts.isStringLiteralLike(type.initializer))
        return type.initializer.text === "process_observed";
    }
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent;
  return null;
}

function enclosingSymbol(node) {
  let foundFunction = false;
  for (let current = node; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    foundFunction = true;
    if (current.name && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isMethodDeclaration(current) || ts.isMethodSignature(current))
      return propertyName(current.name) ?? "<method>";
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name))
        return current.parent.name.text;
      if (ts.isPropertyAssignment(current.parent)) return propertyName(current.parent.name) ?? "<property>";
    }
  }
  return foundFunction ? "<anonymous>" : "<module>";
}

function judgmentContextNode(node) {
  for (let parent = node.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent)
    if (
      ts.isBinaryExpression(parent) ||
      ts.isIfStatement(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isReturnStatement(parent)
    )
      return parent;
  return node;
}

function compareObservationSite(left, right) {
  return observationKey(left).localeCompare(observationKey(right));
}

function observationKey(entry) {
  return `${entry.path}|${entry.symbol}|${entry.kind}|${entry.fingerprint}`;
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
}

function scriptKind(file) {
  return file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : file.endsWith(".js") || file.endsWith(".mjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
}

function read(root, rel) {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}
async function main() {
  if (process.argv.includes("--print-dispatch-observation-baseline")) {
    console.log(
      JSON.stringify(
        {
          schema: "dispatch-lifecycle-observation-baseline/v1",
          authority: "decision/dec_AEB05951C69E47FCE53E53C341#CH4",
          policy: "entries may only be removed; each site is keyed by path, symbol, kind, and source fingerprint",
          entries: scanDispatchLifecycleObservationSites(),
        },
        null,
        2,
      ),
    );
    return;
  }
  const findings = checkDomainJudgmentSingleDefinition();
  if (findings.length) {
    console.error("Domain judgment single-definition check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }
  console.log(
    "Domain judgment single-definition check passed (eight kernel judgments plus dispatch observation ratchet).",
  );
}
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
