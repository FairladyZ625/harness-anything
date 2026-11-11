#!/usr/bin/env node
/**
 * Cross-aggregate judgment single-definition ratchet (DDD slice 3).
 * Authority: dec_399F48E3547D831F1199F51E84 CH1 and the DDD blueprint;
 * dec_6B963E9B83AE4AC73FB0A61E81 CH2 for the projected fact `invalidated` field;
 * dec_6B912A63D279A922FA1288536D CH2 for authored-document readiness.
 * dec_BEFCF7D0484E901F187C2C8EC6 CH1/CH2 for the review reverify route and owner-verify boundary.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadOntologyClosureSnapshot } from "./gates/ontology-gate-lib.mjs";
import { authoredReadinessFindings } from "./domain-judgment-authored-readiness.mjs";
import { git, listWorktreeFiles, pathExistsAt, pullRequestBase } from "./gates/git.mjs";

const DISPATCH_OBSERVATION_BASELINE = "tools/gate-allowlists/dispatch-lifecycle-observation.json",
  OBSERVATION_BASELINE_SCHEMA = "harness-anything/gate-allowlist/v1";

// Legacy declarations remain enforced while S2 moves their owners into EntityKindContract.
const judgments = [
  ["closeoutReadiness", "packages/kernel/src/domain/closeout-readiness.ts", "closeoutReadiness"],
  ["factLiveness", "packages/kernel/src/domain/fact-liveness.ts", "factLiveness"],
  ["blockingOf", "packages/kernel/src/domain/task-blocking.ts", "blockingOf"],
  ["startability", "packages/kernel/src/domain/task-lifecycle-command-transitions.ts", "canStartExecution"],
  ["queryPayloadValidation", "packages/kernel/src/domain/query-payload-validation.ts", "queryPayloadValidation"],
  ["statusVocabulary", "packages/kernel/src/domain/status-vocabulary.ts", "statusVocabularies", "const"],
  [
    "authoredDocumentReadiness",
    "packages/kernel/src/domain/transition-document-readiness.ts",
    "assessAuthoredDocumentReadiness",
  ],
  [
    "transitionDocumentReadiness",
    "packages/kernel/src/domain/transition-document-readiness.ts",
    "assessTransitionDocument",
  ],
  ["reviewReverifyRoute", "packages/kernel/src/domain/review-reverify.ts", "reviewReverifyRoute"],
  [
    "ownerVerifiableFindingCategories",
    "packages/kernel/src/domain/review-reverify.ts",
    "ownerVerifiableFindingCategories",
    "const",
  ],
  ["forwardingIntent", "packages/daemon/src/fleet/forwarding-intent.ts", "forwardingIntentIssue"],
  [
    "closeoutBilingualDelivery",
    "packages/kernel/src/domain/transition-document-readiness.ts",
    "missingChineseCloseoutSections",
  ],
].map(([id, canonical, symbol, declaration = "function"]) => ({ id, canonical, symbol, declaration }));
const requiredConsumers = new Map([
  ["packages/kernel/src/domain/task-lifecycle-review-transitions.ts", "closeoutReadiness("],
  ["packages/kernel/src/domain/completion-readiness.ts", "closeoutReadiness("],
  ["packages/storage/src/projection/sqlite-task-source.ts", "domainCloseoutReadiness("],
  ["packages/storage/src/projection/fact-event-projection.ts", "factLiveness("],
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
  ["packages/kernel/src/domain/task-pr-body.ts", "missingChineseCloseoutSections("],
  ["packages/daemon/src/repo-cell-submit.ts", "missingChineseCloseoutSections("],
  ["packages/daemon/src/transition-document-access.ts", "assertTransitionDocumentReady("],
  ["packages/kernel/src/domain/task-lifecycle-review-transitions.ts#reverify", "reviewReverifyRoute("],
  ["packages/kernel/src/domain/completion-readiness.ts#reverify", "reviewReverifyRoute("],
  ["packages/daemon/src/task-review-dispatch.ts", "reviewReverifyRoute("],
  ["packages/daemon/src/fleet/forwarding-port.ts", "forwardingIntentIssue("],
  ["packages/daemon/src/fleet/center-listener.ts", "forwardingIntentIssue("],
  ["packages/daemon/src/daemon-host-repository-api.ts", "forwardingIntentForAction("],
  ["packages/daemon/src/daemon-host-open.ts", "forwardingIntentForAction("],
]);
/**
 * Whether a finding is re-reviewed is judged only by the kernel route (dec_BEFCF7D0 CH1). Outside the
 * kernel a finding's `reverify` value may be parsed, shape-checked, and displayed, never compared.
 */
const REVERIFY_COMPARISON = /\.reverify\s*(?:===|!==|==|!=|\?\?|\|\|)|(?:===|!==|==|!=)\s*[\w$.?]*\.reverify\b/u;

export function checkDomainJudgmentSingleDefinition(
  root = process.cwd(),
  kinds = loadOntologyClosureSnapshot(root).kinds,
) {
  const findings = [],
    files = listWorktreeFiles(root, ["packages", "tools"]).filter(
      (rel) =>
        /\.(?:ts|tsx|mts|js|jsx|mjs)$/u.test(rel) &&
        !/(?:^|\/)(?:test|tests|fixtures)\//u.test(rel) &&
        !/\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(rel),
    );
  const bodies = new Map(files.map((file) => [file, readFileSync(path.join(root, file), "utf8")])),
    registered = kinds.flatMap((kind) =>
      (kind.judgments ?? []).map((judgment) => {
        const [canonical, symbol] = judgment.symbol.split("#");
        return { ...judgment, canonical, symbol, declaration: "any" };
      }),
    );
  const definitions = new Map();
  for (const [file, body] of bodies) {
    const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const declaration =
        ts.isFunctionDeclaration(node) && node.body
          ? "function"
          : ts.isVariableDeclaration(node) && node.initializer
            ? ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)
              ? "function"
              : "const"
            : null;
      if (declaration && node.name && ts.isIdentifier(node.name)) {
        const key = `${declaration}:${node.name.text}`;
        definitions.set(key, [...(definitions.get(key) ?? []), file]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const judgment of [...judgments, ...registered]) {
    const hits = definitions.get(`${judgment.declaration === "const" ? "const" : "function"}:${judgment.symbol}`) ?? [];
    if (hits.length !== 1 || hits[0] !== judgment.canonical)
      findings.push(
        `${judgment.id}: expected one definition of ${judgment.symbol} at ${judgment.canonical}; ` +
          `found ${hits.length ? hits.join(", ") : "none"}`,
      );
  }
  for (const judgment of registered) {
    for (const file of judgment.consumers) {
      const body = bodies.get(file) ?? "",
        source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true),
        names = new Set(file === judgment.canonical ? [judgment.symbol] : []);
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
        const specifier = node.moduleSpecifier.text,
          imported = specifier.startsWith("@harness-anything/kernel/internal/")
            ? `packages/kernel/src/${specifier.slice("@harness-anything/kernel/internal/".length)}`
            : path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (imported !== judgment.canonical) continue;
        for (const binding of node.importClause?.namedBindings?.elements ?? [])
          if (!binding.isTypeOnly && (binding.propertyName ?? binding.name).text === judgment.symbol)
            names.add(binding.name.text);
      }
      let called = false;
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text))
          called = true;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!called) findings.push(`${file}: must consume named domain judgment ${judgment.id}`);
    }
    for (const rule of judgment.consumerRules ?? []) {
      const scope = new RegExp(rule.pathPattern, "u"),
        pattern = new RegExp(rule.pattern, rule.flags ?? "u");
      for (const [file, body] of bodies)
        if (file !== judgment.canonical && scope.test(file) && pattern.test(body))
          findings.push(`${file}: ${judgment.id}: ${rule.reason}`);
    }
  }
  for (const [key, call] of requiredConsumers) {
    const file = key.split("#")[0];
    if (!(bodies.get(file) ?? "").includes(call))
      findings.push(`${file}: must consume named domain judgment ${call.slice(0, -1)}`);
  }
  for (const file of files) {
    if (
      !/^packages\/(?:daemon|cli|gui|application|storage)\//u.test(file) ||
      /^packages\/daemon\/src\/protocol\//u.test(file)
    )
      continue;
    if (REVERIFY_COMPARISON.test(readFileSync(path.join(root, file), "utf8")))
      findings.push(`${file}: judges a finding's reverify outside the kernel reviewReverifyRoute`);
  }
  const taskAdapter = read(root, "packages/gui/src/renderer/task-adapter.ts"),
    triadic = read(root, "packages/gui/src/renderer/triadic-data.ts");
  const daemonDispatch = read(root, "packages/daemon/src/repo-cell-action-dispatch.ts"),
    taskSurface = read(root, "packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts");
  if (/function\s+(?:deriveBlocking|closeoutReadiness|gateResults)\s*\(/u.test(taskAdapter))
    findings.push("packages/gui/src/renderer/task-adapter.ts: recomputes closeout or blocking judgment");
  if (!/invalidated:\s*row\.invalidated\b/u.test(triadic))
    findings.push(
      "packages/gui/src/renderer/triadic-data.ts: must consume the projected fact `invalidated` field (row.invalidated)",
    );
  for (const [file, body] of bodies)
    if (file.startsWith("packages/gui/") && /===\s*"superseded_fact"|"superseded_fact"\s*===/u.test(body))
      findings.push(`${file}: compares the fact liveness word instead of reading the projected invalidated field`);
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
  findings.push(...authoredReadinessFindings(root));
  const baseline = readDispatchObservationBaseline(root),
    dispatchSites = scanDispatchLifecycleObservationSites(root),
    // Without a baseline at this cut there is nothing to ratchet: every site is a finding.
    priorBaseline = baseline === null ? null : readPreviousDispatchObservationEntries(root);
  findings.push(...checkDispatchLifecycleObservationSites(dispatchSites, baseline, priorBaseline));
  return findings;
}

export function scanDispatchLifecycleObservationSites(root = process.cwd()) {
  const sites = [],
    files = listWorktreeFiles(root, ["packages"]).filter(
      (rel) =>
        /\.(?:ts|tsx|mts|js|jsx|mjs)$/u.test(rel) &&
        /(?:^|\/)src\//u.test(rel) &&
        // The kernel domain is the single home of these judgments; everything else reads its port.
        !rel.startsWith("packages/kernel/src/domain/") &&
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
        !insideDispatchObservationPayload(node)
      )
        add(judgmentContextNode(node), enclosingSymbol(node), "runtimePidIsAlive");
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["has", "get"].includes(node.expression.name.text) &&
        trailingName(node.expression.expression) === "processes"
      )
        add(judgmentContextNode(node), enclosingSymbol(node), "process-table-probe");
      if (ts.isBinaryExpression(node) && equalityOperators.has(node.operatorToken.kind)) {
        const names = [trailingName(node.left), trailingName(node.right)];
        if (names.includes("liveness") && !insideDispatchObservationPayload(node))
          add(judgmentContextNode(node), enclosingSymbol(node), "liveness-comparison");
        if (names.includes("fallbackState") && !insideDispatchObservationPayload(node))
          add(judgmentContextNode(node), enclosingSymbol(node), "fallback-state-branch");
      }
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
    baselineEntries = observationEntries(baseline) ?? [],
    allowed = countEntries(baselineEntries);
  if (observationEntries(baseline) === null)
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

/** The baseline is a B13-classified gate allowlist; its one section lists the remaining sites. */
function observationEntries(baseline) {
  return baseline?.schema === OBSERVATION_BASELINE_SCHEMA && Array.isArray(baseline.entries?.observationSites)
    ? baseline.entries.observationSites
    : null;
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
  const file = path.join(root, DISPATCH_OBSERVATION_BASELINE);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** The base cut's entries bound this cut's baseline; null before the baseline existed at base. */
function readPreviousDispatchObservationEntries(root) {
  const base = process.env.PR_BASE_SHA || pullRequestBase(root);
  if (!pathExistsAt(root, base, DISPATCH_OBSERVATION_BASELINE)) return null;
  const previous = JSON.parse(git(root, ["show", `${base}:${DISPATCH_OBSERVATION_BASELINE}`]));
  return observationEntries(previous) ?? [];
}

function insideDispatchObservationPayload(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isObjectLiteralExpression(parent)) {
      const type = parent.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          propertyName(property.name) === "type" &&
          ts.isStringLiteralLike(property.initializer),
      );
      if (type && ts.isPropertyAssignment(type) && ts.isStringLiteralLike(type.initializer))
        return type.initializer.text === "runtime_session_liveness_changed";
    }
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

const equalityOperators = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** `a.b.liveness`, `a?.liveness`, and a bare `liveness` all end in the name `liveness`. */
function trailingName(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression))
    return current.argumentExpression.text;
  return null;
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
    const sliceOf = new Map(
      (observationEntries(readDispatchObservationBaseline(process.cwd())) ?? []).map((entry) => [
        observationKey(entry),
        entry.slice,
      ]),
    );
    console.log(
      JSON.stringify(
        {
          schema: OBSERVATION_BASELINE_SCHEMA,
          authority: "decision/dec_AEB05951C69E47FCE53E53C341#CH4",
          policy: "entries may only be removed; each site is keyed by path, symbol, kind, and source fingerprint",
          // Regeneration keeps each surviving entry's reviewed migration slice; new sites stay unassigned.
          entries: {
            observationSites: scanDispatchLifecycleObservationSites().map((site) => ({
              ...site,
              slice: sliceOf.get(observationKey(site)) ?? "unassigned",
            })),
          },
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
    "Domain judgment single-definition check passed (legacy and registry judgments resolve to their canonical domain services; authored-document reads use the projection port; dispatch observation ratchet is active).",
  );
}
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
