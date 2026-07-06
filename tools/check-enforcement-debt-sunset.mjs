#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = parseRoot(process.argv.slice(2));
const now = parseNow(process.argv.slice(2));
const sunsetDays = 14;
const terminalTaskStatuses = new Set(["done", "cancelled"]);
const enforcementPattern = /\b(?:enforcement|gate|check|contract|boundary|sunset)\b|治理|门禁|契约|边界/u;

const decisionsRoot = path.join(root, "harness/decisions");
const tasksRoot = path.join(root, "harness/tasks");

if (!existsSync(decisionsRoot) || !existsSync(tasksRoot)) {
  console.log("Enforcement debt sunset check skipped: private harness/decisions or harness/tasks root is absent in this checkout.");
  process.exit(0);
}

const tasks = readTasks(tasksRoot);
const overdue = [];
let scannedRelations = 0;

for (const decision of readDecisions(decisionsRoot)) {
  if (decision.state !== "active") continue;
  const decisionDate = decision.decidedAt ?? decision.proposedAt;
  if (!decisionDate) continue;
  const ageDays = Math.floor((now.getTime() - decisionDate.getTime()) / 86_400_000);
  if (ageDays <= sunsetDays) continue;

  for (const relation of decision.relations) {
    if (relation.type !== "derives" || relation.state !== "active" || !relation.target.startsWith("task/")) continue;
    scannedRelations += 1;
    const taskId = relation.target.slice("task/".length);
    const task = tasks.get(taskId);
    const enforcementText = `${task?.title ?? ""} ${relation.rationale ?? ""} ${decision.title}`;
    if (!enforcementPattern.test(enforcementText)) continue;
    const status = task?.status ?? "missing";
    if (terminalTaskStatuses.has(status)) continue;
    overdue.push({
      decisionId: decision.decisionId,
      taskId,
      status,
      ageDays,
      decisionPath: decision.path,
      taskPath: task?.path ?? null,
      title: task?.title ?? "(missing task package)"
    });
  }
}

if (overdue.length > 0) {
  console.error(`Enforcement debt sunset check failed with ${overdue.length} overdue enforcement task(s):`);
  for (const item of overdue) {
    console.error(`- ${item.decisionId} derives ${item.taskId} (${item.status}, ${item.ageDays}d): ${item.title}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Enforcement debt sunset check passed (${scannedRelations} aged active derives relation(s) scanned, 0 overdue enforcement task(s)).`);
}

function readDecisions(dir) {
  return listFiles(dir, "decision.md").flatMap((file) => {
    const body = readFileSync(file, "utf8");
    const frontmatter = readFrontmatter(body);
    if (!frontmatter || readScalar(frontmatter, "schema") !== "decision-package/v1") return [];
    return [{
      path: relative(file),
      decisionId: readScalar(frontmatter, "decision_id") ?? path.basename(path.dirname(file)),
      title: readScalar(frontmatter, "title") ?? "",
      state: readScalar(frontmatter, "state") ?? "",
      proposedAt: parseDate(readScalar(frontmatter, "proposedAt")),
      decidedAt: parseDate(readScalar(frontmatter, "decidedAt")),
      relations: parseRelations(frontmatter)
    }];
  });
}

function readTasks(dir) {
  const tasks = new Map();
  for (const file of listFiles(dir, "INDEX.md")) {
    const body = readFileSync(file, "utf8");
    const frontmatter = readFrontmatter(body);
    if (!frontmatter || readScalar(frontmatter, "schema") !== "task-package/v2") continue;
    const taskId = readScalar(frontmatter, "task_id") ?? path.basename(path.dirname(file));
    tasks.set(taskId, {
      taskId,
      path: relative(file),
      title: readScalar(frontmatter, "title") ?? "",
      status: readScalar(frontmatter, "  status") ?? "unknown"
    });
  }
  return tasks;
}

function listFiles(dir, basename) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, basename));
    else if (entry.name === basename) files.push(full);
  }
  return files;
}

function readFrontmatter(body) {
  const match = /^---\n([\s\S]*?)\n---/u.exec(body);
  return match?.[1] ?? "";
}

function readScalar(frontmatter, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, "mu").exec(frontmatter);
  if (!match) return null;
  return unquote(match[1] ?? "");
}

function parseRelations(frontmatter) {
  const relations = [];
  for (const match of frontmatter.matchAll(/^\s*-\s*\{([^}]+)\}\s*$/gmu)) {
    const fields = parseFlowFields(match[1] ?? "");
    if (fields.type && fields.target) {
      relations.push({
        type: fields.type,
        target: fields.target,
        state: fields.state ?? "active",
        rationale: fields.rationale ?? ""
      });
    }
  }
  return relations;
}

function parseFlowFields(body) {
  const fields = {};
  for (const match of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*("(?:[^"\\]|\\.)*"|[^,]+)(?:,|$)/gu)) {
    fields[match[1]] = unquote(match[2]?.trim() ?? "");
  }
  return fields;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  return index === -1 ? process.cwd() : path.resolve(argv[index + 1] ?? process.cwd());
}

function parseNow(argv) {
  const index = argv.indexOf("--now");
  const parsed = index === -1 ? new Date() : new Date(argv[index + 1]);
  if (Number.isNaN(parsed.getTime())) throw new Error("--now must be an ISO date");
  return parsed;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}
