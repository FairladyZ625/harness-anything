#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_SCRIPT_CONTEXT;
const resultPath = process.env.HARNESS_SCRIPT_RESULT;
if (!contextPath || !resultPath) {
  throw new Error("script context and result paths are required");
}

const context = JSON.parse(readFileSync(contextPath, "utf8"));
const decisionId = String(context.inputs?.decisionId ?? "").trim();
if (!decisionId) {
  fail("adr-render requires --input decisionId=<id>");
}

const decisionsRoot = context.paths.decisionsRoot;
const adrRoot = context.paths.adrRoot;
const decisionDocumentPath = path.join(decisionsRoot, `decision-${decisionId}`, "decision.md");
if (!existsSync(decisionDocumentPath)) {
  fail(`decision document not found for ${decisionId} at ${decisionDocumentPath}`);
}

const decision = readDecisionSourceFields(readDecisionFrontmatter(readFileSync(decisionDocumentPath, "utf8")));
if (decision.decision_id && decision.decision_id !== decisionId) {
  fail(`decision_id mismatch: input ${decisionId} vs frontmatter ${decision.decision_id}`);
}

const existingAdrs = listAdrFiles(adrRoot);
const anchored = existingAdrs.find((entry) => machineAnchorDecisionId(entry.body) === decisionId);
const adrNumber = anchored ? anchored.number : nextAdrNumber(existingAdrs);
const slug = kebabCase(decision.title || decisionId);
const adrFileName = anchored ? anchored.fileName : `ADR-${adrNumber}-${slug}.md`;
const adrPath = path.join(adrRoot, adrFileName);

const humanBlock = anchored ? extractHumanBlock(anchored.body) : defaultHumanBlock();
const machineBlock = renderMachineBlock(decision, adrNumber);
const rendered = `${machineBlock}\n\n${humanBlock}\n`;

mkdirSync(adrRoot, { recursive: true });
writeFileSync(adrPath, rendered, "utf8");

writeFileSync(resultPath, JSON.stringify({
  schema: "script-result/v1",
  ok: true,
  report: {
    scriptId: context.scriptId,
    source: context.source,
    verticalId: context.verticalId,
    decisionId,
    adrNumber,
    adrPath: path.relative(context.paths.rootDir, adrPath).split(path.sep).join("/"),
    reused: Boolean(anchored),
    watermark: decision._coordinatorWatermark ?? null
  },
  produced: [path.relative(context.paths.rootDir, adrPath).split(path.sep).join("/")]
}, null, 2), "utf8");

function fail(hint) {
  const target = process.env.HARNESS_SCRIPT_RESULT;
  if (target) {
    writeFileSync(target, JSON.stringify({
      schema: "script-result/v1",
      ok: false,
      report: { error: hint },
      produced: []
    }, null, 2), "utf8");
  }
  process.stderr.write(`${hint}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Rendering (§1 field mapping, §3.2 sentinel partitions)
// ---------------------------------------------------------------------------

function renderMachineBlock(decision, adrNumber) {
  const title = decision.title || decision.decision_id;
  const watermark = decision._coordinatorWatermark
    ? ` @ ${decision._coordinatorWatermark}`
    : "";
  const lines = [];
  lines.push(`<!-- adr-render:begin machine (decision ${decision.decision_id}${watermark}) -->`);
  lines.push(`# ADR-${adrNumber} · ${title}`);
  lines.push("");
  lines.push(...renderStatus(decision));
  lines.push("");
  lines.push(...renderContext(decision));
  lines.push("");
  lines.push(...renderDecision(decision));
  lines.push("");
  lines.push(...renderConsequences(decision));
  const provenance = renderProvenance(decision);
  if (provenance.length > 0) {
    lines.push("");
    lines.push(...provenance);
  }
  lines.push("<!-- adr-render:end machine -->");
  return lines.join("\n");
}

function renderStatus(decision) {
  const lines = ["## Status", ""];
  lines.push(statusLine(decision));
  lines.push("");
  lines.push(`- Decision 锚：\`${decision.decision_id}\`（${decision.state}）`);
  return lines;
}

function statusLine(decision) {
  switch (decision.state) {
    case "active":
      return decision.decidedAt ? `Accepted ${decision.decidedAt}` : "Accepted";
    case "proposed":
      return "Proposed";
    case "rejected":
      return "Rejected";
    case "deferred":
      return "Deferred";
    case "retired":
    case "superseded":
      return "Superseded";
    default:
      return decision.state || "Unknown";
  }
}

function renderContext(decision) {
  const lines = ["## Context", ""];
  lines.push(`本 ADR 回答：${decision.question}`);
  const scope = [];
  if (decision.riskTier) scope.push(`riskTier=${decision.riskTier}`);
  if (decision.urgency) scope.push(`urgency=${decision.urgency}`);
  const modules = decision.applies_to?.modules ?? [];
  if (modules.length > 0) scope.push(`modules=${modules.join(", ")}`);
  if (scope.length > 0) {
    lines.push("");
    lines.push(`范围：${scope.join("；")}`);
  }
  return lines;
}

function renderDecision(decision) {
  const lines = ["## Decision", ""];
  for (const chosen of decision.chosen ?? []) {
    lines.push(`### ${chosen.id} · ${chosen.text}`);
    lines.push("");
  }
  const rejected = decision.rejected ?? [];
  if (rejected.length > 0) {
    lines.push("被否选项：");
    lines.push("");
    for (const entry of rejected) {
      lines.push(`- ✗ ${entry.text} — 否决理由：${entry.why_not}`);
    }
  }
  return trimTrailingBlank(lines);
}

function renderConsequences(decision) {
  const lines = ["## Consequences", ""];
  const claims = decision.claims ?? [];
  for (const claim of claims) {
    lines.push(`- ${claim.id}：${claim.text}`);
  }
  const relations = decision.relations ?? [];
  if (relations.length > 0) {
    lines.push("");
    lines.push("关联：");
    lines.push("");
    for (const relation of relations) {
      const rationale = relation.rationale ? `（${relation.rationale}）` : "";
      lines.push(`- ${relation.type} → ${relation.target}${rationale}`);
    }
  }
  return trimTrailingBlank(lines);
}

function renderProvenance(decision) {
  const provenance = decision.provenance ?? [];
  if (provenance.length === 0) return [];
  const first = provenance[0] ?? {};
  const runtime = first.runtime ? `runtime=${first.runtime}` : "";
  const session = first.sessionId ? `session=${first.sessionId}` : "";
  const provenanceTail = [runtime, session].filter(Boolean).join("；");
  const proposedAt = decision.proposedAt ? ` 于 ${decision.proposedAt}` : "";
  const suffix = provenanceTail ? `；${provenanceTail}` : "";
  return [`> Decision${proposedAt} proposed${suffix}。`];
}

function defaultHumanBlock() {
  return [
    "<!-- adr-render:human -->",
    "## Context（人工补充）",
    "",
    "此处人工补充：长文叙事、Refines/Supersedes 关系行、跨 ADR 论证。",
    "机器段（上方 machine 区）每次重渲染整块覆盖，此人工区永久保留。"
  ].join("\n");
}

// ---------------------------------------------------------------------------
// ADR numbering & idempotency (§3.1)
// ---------------------------------------------------------------------------

function listAdrFiles(adrRoot) {
  if (!existsSync(adrRoot)) return [];
  return readdirSync(adrRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const number = adrNumberFromFileName(entry.name);
      return number === undefined ? undefined : {
        fileName: entry.name,
        number,
        body: readFileSync(path.join(adrRoot, entry.name), "utf8")
      };
    })
    .filter((entry) => entry !== undefined);
}

function adrNumberFromFileName(fileName) {
  const match = /^ADR-(\d{4})/u.exec(fileName) ?? /^(\d{4})-/u.exec(fileName);
  return match ? match[1] : undefined;
}

function nextAdrNumber(existingAdrs) {
  const max = existingAdrs.reduce((acc, entry) => Math.max(acc, Number(entry.number)), -1);
  return String(max + 1).padStart(4, "0");
}

function machineAnchorDecisionId(body) {
  const match = /<!--\s*adr-render:begin machine \(decision ([A-Za-z0-9_-]+)/u.exec(body);
  return match ? match[1] : undefined;
}

function extractHumanBlock(body) {
  const index = body.indexOf("<!-- adr-render:human -->");
  if (index === -1) return defaultHumanBlock();
  return body.slice(index).replace(/\n+$/u, "");
}

function kebabCase(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60)
    .replace(/-+$/u, "") || "decision";
}

function trimTrailingBlank(lines) {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop();
  return copy;
}

// ---------------------------------------------------------------------------
// Inlined decision frontmatter parser (ported from sqlite-decision-source.ts)
// Kept self-contained: sandboxed script cannot import kernel sources at runtime.
// ---------------------------------------------------------------------------

function readDecisionFrontmatter(body) {
  const match = body.match(/^---\n([\s\S]*?)\n---/u);
  return match ? match[1] : "";
}

function readDecisionSourceFields(frontmatter) {
  return {
    decision_id: readDecisionScalarField(frontmatter, "decision_id"),
    _coordinatorWatermark: optional(unquote(readDecisionScalarField(frontmatter, "_coordinatorWatermark"))),
    title: unquote(readDecisionScalarField(frontmatter, "title")),
    state: readDecisionScalarField(frontmatter, "state") || "unknown",
    riskTier: readDecisionScalarField(frontmatter, "riskTier"),
    urgency: readDecisionScalarField(frontmatter, "urgency"),
    applies_to: {
      modules: parseStringArray(readBlockScalar(frontmatter, "applies_to", "modules")),
      productLines: parseStringArray(readBlockScalar(frontmatter, "applies_to", "productLines"))
    },
    proposedAt: unquote(readDecisionScalarField(frontmatter, "proposedAt")),
    decidedAt: optional(unquote(readDecisionScalarField(frontmatter, "decidedAt"))),
    provenance: parseObjectList(frontmatter, "provenance"),
    question: unquote(readDecisionScalarField(frontmatter, "question")),
    chosen: parseObjectList(frontmatter, "chosen"),
    rejected: parseObjectList(frontmatter, "rejected"),
    claims: parseObjectList(frontmatter, "claims"),
    relations: parseObjectList(frontmatter, "relations")
  };
}

function readDecisionScalarField(frontmatter, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = frontmatter.match(new RegExp(`^${escaped}:[ \\t]*(.*)$`, "mu"));
  return match ? match[1].trim() : "";
}

function readBlockScalar(frontmatter, blockName, key) {
  return readIndentedBlock(frontmatter, blockName)
    .find((line) => line.trimStart().startsWith(`${key}:`))
    ?.replace(new RegExp(`^\\s*${key}:\\s*`, "u"), "")
    .trim() ?? "[]";
}

function parseObjectList(frontmatter, key) {
  const items = [];
  let current = null;
  for (const rawLine of readIndentedBlock(frontmatter, key)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("- ")) {
      if (current) items.push(current);
      const body = line.slice(2).trim();
      current = body.startsWith("{") ? parseFlowObject(body) : parseBlockObjectLine(body);
      continue;
    }
    if (!current) continue;
    for (const [entryKey, entryValue] of Object.entries(parseBlockObjectLine(line))) {
      current[entryKey] = entryValue;
    }
  }
  if (current) items.push(current);
  return items;
}

function readIndentedBlock(frontmatter, key) {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return [];
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*:/u.test(line)) break;
    block.push(line);
  }
  return block;
}

function parseFlowObject(value) {
  const body = value.trim().replace(/^\{\s*/u, "").replace(/\s*\}$/u, "");
  const result = {};
  for (const part of splitTopLevel(body)) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    result[key] = parseDecisionScalar(part.slice(separator + 1).trim());
  }
  return result;
}

function parseBlockObjectLine(value) {
  const separator = value.indexOf(":");
  if (separator === -1) return {};
  const key = value.slice(0, separator).trim();
  return { [key]: parseDecisionScalar(value.slice(separator + 1).trim()) };
}

function parseDecisionScalar(value) {
  if (value.startsWith("{")) return parseFlowObject(value);
  if (value.startsWith("[")) return parseStringArray(value);
  return unquote(value);
}

function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (char === "\"" && previous !== "\\") inString = !inString;
    if (!inString && (char === "{" || char === "[")) depth += 1;
    if (!inString && (char === "}" || char === "]")) depth -= 1;
    if (!inString && depth === 0 && char === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseStringArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function unquote(value) {
  if (!value) return "";
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function optional(value) {
  return value ? value : undefined;
}
