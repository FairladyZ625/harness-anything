#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");

const context = JSON.parse(readFileSync(contextPath, "utf8"));
const paths = context.paths ?? {};
const inputs = context.inputs ?? {};
const outputRoot = context.outputRoot;
const parentTaskId = context.taskId;

if (!outputRoot) throw new Error("context.outputRoot is required");
if (!parentTaskId) throw new Error("context.taskId is required");

const artifactsDir = path.join(outputRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const childRoles = parseRoles(inputs.childRoles);
const dependencyStyle = String(inputs.dependencyStyle ?? "chain");
const titlePrefixFormat = String(inputs.titlePrefixFormat ?? "[{role}] ");
const rootDir = String(paths.rootDir ?? process.cwd());

const allTasks = Array.isArray(context.taskIndex) ? context.taskIndex : [];
const parentTask = allTasks.find((task) => task.taskId === parentTaskId);

if (!parentTask) {
  writeFailure("parent_task_not_found", `Parent task was not found: ${parentTaskId}`, {
    schema: "subtask-expansion-plan/v1",
    parentTaskId,
    roles: childRoles,
    pendingCount: 0,
    existsCount: 0,
    edgeCount: 0
  });
  process.exit(0);
}

const warnings = [];
if (["done", "cancelled", "archived"].includes(parentTask.status)) {
  warnings.push({
    code: "parent_in_terminal_status",
    message: `Parent task ${parentTaskId} is in terminal status ${parentTask.status}.`
  });
}

const parentTitle = parentTask.title || parentTaskId;
const parentPlanSummary = parentTask.taskPlanSummary || "";
const milestoneNotes = Array.isArray(context.milestoneNotes) ? context.milestoneNotes : [];
const existingRoleMap = new Map();
for (const task of allTasks.filter((candidate) => candidate.parent === parentTaskId)) {
  const role = roleFromTitle(task.title, childRoles, titlePrefixFormat);
  if (role && !existingRoleMap.has(role)) existingRoleMap.set(role, task);
}

const children = childRoles.map((role) => {
  const existing = existingRoleMap.get(role);
  const title = `${expandTitlePrefix(titlePrefixFormat, role)}${parentTitle}`;
  return {
    role,
    enabled: true,
    status: existing ? "exists" : "pending",
    ...(existing ? { existingTaskId: existing.taskId } : {}),
    title,
    brief: briefForRole(role, parentTitle, parentPlanSummary, milestoneNotes),
    createCommand: `ha task create --title ${quoteShell(title)} --parent ${parentTaskId} --vertical software/coding --preset standard-task --json`
  };
});

const dependencies = buildDependencies(children, dependencyStyle);
const cycle = detectRoleCycle(children, dependencies);
if (cycle) {
  writeFailure("subtask_plan_cycle", `Generated dependency graph contains a cycle: ${cycle.join(" -> ")}`, {
    schema: "subtask-expansion-plan/v1",
    parentTaskId,
    roles: childRoles,
    pendingCount: children.filter((child) => child.status === "pending").length,
    existsCount: children.filter((child) => child.status === "exists").length,
    edgeCount: dependencies.length
  });
  process.exit(0);
}

const plan = {
  schema: "subtask-plan/v1",
  parentTaskId,
  generatedAt: new Date().toISOString(),
  children,
  dependencies,
  applyContract: {
    order: ["create-all-children", "then-relate-by-role-map"],
    idempotencyKey: "title-role-prefix-under-parent",
    relateCommandTemplate: "ha task relate <sourceTaskId> depends-on <targetTaskId> --rationale \"<rationale>\" --json"
  }
};

writeJson(path.join(artifactsDir, "subtask-plan.json"), plan);
writeFileSync(path.join(artifactsDir, "subtask-plan.md"), renderMarkdown(plan), "utf8");
writeJson(path.join(artifactsDir, "preset-result.json"), {
  schema: "script-result/v1",
  ok: true,
  report: {
    schema: "subtask-expansion-plan/v1",
    parentTaskId,
    roles: childRoles,
    pendingCount: children.filter((child) => child.status === "pending").length,
    existsCount: children.filter((child) => child.status === "exists").length,
    edgeCount: dependencies.length,
    planPath: toRelative(rootDir, path.join(artifactsDir, "subtask-plan.json"))
  },
  ...(warnings.length > 0 ? { warnings } : {}),
  produced: ["artifacts/subtask-plan.json", "artifacts/subtask-plan.md"]
});

function parseRoles(value) {
  const roles = String(value ?? "implement,test,qa,review")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  return roles.length > 0 ? [...new Set(roles)] : ["implement", "test", "qa", "review"];
}

function roleFromTitle(title, roles, prefixFormat) {
  for (const role of roles) {
    if (String(title ?? "").startsWith(expandTitlePrefix(prefixFormat, role))) return role;
  }
  return undefined;
}

function expandTitlePrefix(format, role) {
  return format.replaceAll("{role}", role);
}

function briefForRole(role, parentTitle, parentPlanSummary, milestoneNotes) {
  const parentSummary = parentPlanSummary || `parent task ${parentTitle}`;
  if (role === "implement") {
    return {
      objective: `Implement the planned change for ${parentTitle}.`,
      scope: `Use the parent task plan as source context: ${parentSummary}`,
      acceptance: [
        "Implementation is complete within the parent task scope.",
        "No ledger writes are made outside sanctioned task commands and task documents."
      ]
    };
  }
  if (role === "test") {
    return {
      objective: `Verify the implementation for ${parentTitle}.`,
      scope: "Add or update focused automated tests and run the relevant verification commands.",
      acceptance: [
        "Regression coverage demonstrates the implemented behavior.",
        "Relevant tests pass from a clean command invocation."
      ]
    };
  }
  if (role === "qa") {
    return {
      objective: `Exercise the user-facing and integration behavior for ${parentTitle}.`,
      scope: "Check acceptance criteria, edge cases, and any milestone-facing evidence.",
      acceptance: [
        "Manual or scripted QA evidence covers the main workflow.",
        ...(milestoneNotes.length > 0 ? milestoneNotes : ["Open questions or risks are recorded before review."])
      ]
    };
  }
  if (role === "review") {
    return {
      objective: `Review and close the subtask expansion for ${parentTitle}.`,
      scope: "Inspect implementation, tests, QA evidence, and dependency links before final handoff.",
      acceptance: [
        "Review findings are recorded or explicitly cleared.",
        "The parent task has enough evidence to continue or close."
      ]
    };
  }
  return {
    objective: `Handle ${role} work for ${parentTitle}.`,
    scope: `Follow the parent task plan: ${parentSummary}`,
    acceptance: ["Role-specific work is complete and evidence is recorded."]
  };
}

function buildDependencies(children, style) {
  const enabledRoles = children.filter((child) => child.enabled).map((child) => child.role);
  if (style !== "chain") {
    return [];
  }
  const dependencies = [];
  for (let index = 1; index < enabledRoles.length; index += 1) {
    const sourceRole = enabledRoles[index];
    const targetRole = enabledRoles[index - 1];
    dependencies.push({
      sourceRole,
      type: "depends-on",
      targetRole,
      rationale: `${sourceRole} waits for ${targetRole} (subtask-expansion chain)`
    });
  }
  return dependencies;
}

function detectRoleCycle(children, dependencies) {
  const roles = children.map((child) => child.role);
  const edges = new Map(roles.map((role) => [role, []]));
  for (const dependency of dependencies) {
    edges.get(dependency.sourceRole)?.push(dependency.targetRole);
  }
  const visiting = new Set();
  const visited = new Set();
  const pathStack = [];
  for (const role of roles) {
    const cycle = visit(role, edges, visiting, visited, pathStack);
    if (cycle) return cycle;
  }
  return null;
}

function visit(role, edges, visiting, visited, pathStack) {
  if (visiting.has(role)) return [...pathStack.slice(pathStack.indexOf(role)), role];
  if (visited.has(role)) return null;
  visiting.add(role);
  pathStack.push(role);
  for (const next of edges.get(role) ?? []) {
    const cycle = visit(next, edges, visiting, visited, pathStack);
    if (cycle) return cycle;
  }
  pathStack.pop();
  visiting.delete(role);
  visited.add(role);
  return null;
}

function renderMarkdown(plan) {
  const lines = [
    "# Subtask Expansion Plan",
    "",
    `Parent task: \`${plan.parentTaskId}\``,
    "",
    "## Children",
    "",
    "| Role | Status | Task | Title |",
    "| --- | --- | --- | --- |"
  ];
  for (const child of plan.children) {
    lines.push(`| ${child.role} | ${child.status} | ${child.existingTaskId ? `\`${child.existingTaskId}\`` : "pending"} | ${escapeTable(child.title)} |`);
  }
  lines.push("", "## Create Commands", "");
  for (const child of plan.children) {
    if (child.status === "exists") {
      lines.push(`- ${child.role}: skip create, reuse \`${child.existingTaskId}\`.`);
    } else {
      lines.push(`- ${child.role}: \`${child.createCommand}\``);
    }
  }
  lines.push("", "## Dependency Commands", "");
  for (const dependency of plan.dependencies) {
    lines.push(`- ${dependency.sourceRole} depends-on ${dependency.targetRole}: instantiate \`${plan.applyContract.relateCommandTemplate}\` with rationale "${dependency.rationale}".`);
  }
  lines.push("", "## Idempotency", "", `Use \`${plan.applyContract.idempotencyKey}\`: an existing direct child whose title starts with its role prefix is reused on the next plan run.`, "");
  return `${lines.join("\n")}\n`;
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|");
}

function quoteShell(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function writeFailure(code, hint, report) {
  writeJson(path.join(artifactsDir, "preset-result.json"), {
    schema: "script-result/v1",
    ok: false,
    report,
    error: { code: "preset_script_result_failed", hint }
  });
}

function writeJson(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toRelative(fromRoot, filename) {
  return path.relative(fromRoot, filename).split(path.sep).join("/");
}
