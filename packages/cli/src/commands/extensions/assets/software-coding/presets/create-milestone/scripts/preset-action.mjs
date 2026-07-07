#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderMilestoneDossierHtml } from "./dossier-html.mjs";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");

const context = JSON.parse(readFileSync(contextPath, "utf8"));
const entrypoint = String(context.entrypoint ?? String(context.scriptId ?? "").split(":").pop() ?? "");
const paths = context.paths ?? {};
const inputs = context.inputs ?? {};
const outputRoot = String(context.outputRoot ?? "");
const artifactsDir = path.join(outputRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

if (entrypoint === "scaffold") {
  runScaffold();
} else if (entrypoint === "render-html") {
  runRenderHtml();
} else if (entrypoint === "check") {
  runCheck();
} else {
  fail("unknown_entrypoint", `Unsupported create-milestone entrypoint: ${entrypoint}`);
}

function runScaffold() {
  const line = requiredSlugInput("line");
  const slug = requiredSlugInput("slug");
  const charterDecision = requiredDecisionInput("charterDecision");
  const rootTaskId = String(context.taskId ?? "").trim();
  if (!rootTaskId) fail("missing_root_task", "Task context is required.");
  const rootTask = findTask(rootTaskId);
  if (!rootTask) fail("missing_root_task", `Root task ${rootTaskId} was not found in the task index context.`);
  const decision = findDecision(charterDecision);
  if (!decision) fail("missing_charter_decision", `Charter decision ${charterDecision} was not found under decisions root.`);

  const milestoneName = optionalInput("milestoneName") || rootTask.title || slug;
  const mission = optionalInput("mission") || rootTask.taskPlanSummary || `Deliver ${milestoneName}.`;
  const status = optionalInput("status") || "planned";
  const firstUser = optionalInput("firstUser") || "TBD";
  const switchWhen = optionalInput("switchWhen") || "TBD";
  const retireWhen = optionalInput("retireWhen") || "TBD";
  const dependencies = optionalInput("dependencies") || "TBD";
  const waves = parseListInput("waves");

  const milestoneDir = path.join(paths.milestonesRoot, line, slug);
  const overviewPath = path.join(milestoneDir, "00-overview.md");
  if (existsSync(overviewPath)) {
    fail("milestone_map_exists", `${relative(overviewPath)} already exists; scaffold will not overwrite milestone content.`);
  }
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(overviewPath, renderOverview({
    milestoneName,
    status,
    rootTaskId,
    mission,
    firstUser,
    switchWhen,
    retireWhen,
    dependencies,
    charterDecision,
    waves
  }), "utf8");

  const roadmapPath = path.join(paths.milestonesRoot, "00-roadmap.md");
  const dossierPath = path.join(paths.milestonesRoot, "dossier-data.md");
  upsertRoadmapRow(roadmapPath, { line, slug, milestoneName, mission, status, dependencies, rootTaskId });
  upsertDossierRow(dossierPath, { line, milestoneName, mission, status, dependencies, rootTaskId });
  const htmlResult = renderMilestoneDossierHtml({ paths, artifactsDir });

  const report = buildCheckReport({ line, slug, requireDecisionAnchor: true });
  writeResult({
    ok: report.status === "passed",
    report: {
      schema: "create-milestone-scaffold-report/v1",
      status: report.status,
      rootTaskId,
      milestone: { line, slug, path: relative(overviewPath) },
      charterDecision,
      generatedMilestoneFiles: [relative(overviewPath), relative(roadmapPath), relative(dossierPath), htmlResult.path],
      html: htmlResult,
      check: report
    },
    error: report.status === "passed" ? undefined : {
      code: "preset_script_result_failed",
      hint: "create-milestone scaffold produced an incomplete milestone surface."
    }
  });
}

function runRenderHtml() {
  const htmlResult = renderMilestoneDossierHtml({ paths, artifactsDir });
  writeResult({
    ok: true,
    report: {
      schema: "create-milestone-render-html-report/v1",
      status: "passed",
      html: htmlResult
    },
    produced: [htmlResult.path]
  });
}

function runCheck() {
  const line = optionalInput("line");
  const slug = optionalInput("slug");
  const requireDecisionAnchor = optionalInput("requireDecisionAnchor") === "true";
  const report = buildCheckReport({ line, slug, requireDecisionAnchor });
  writeResult({
    ok: report.status === "passed",
    report,
    error: report.status === "passed" ? undefined : {
      code: "preset_script_result_failed",
      hint: "create-milestone checker found missing milestone structure."
    }
  });
}

function buildCheckReport(options = {}) {
  const milestoneRoots = options.line && options.slug
    ? [path.join(paths.milestonesRoot, options.line, options.slug, "00-overview.md")]
    : walk(paths.milestonesRoot).filter((filePath) => path.basename(filePath) === "00-overview.md");
  const roadmap = readOptional(path.join(paths.milestonesRoot, "00-roadmap.md"));
  const dossier = readOptional(path.join(paths.milestonesRoot, "dossier-data.md"));
  const items = milestoneRoots.map((overviewPath) => checkOverview(overviewPath, roadmap, dossier, options));
  const missing = items.flatMap((item) => item.missing.map((missingItem) => ({
    milestone: item.milestone,
    path: item.path,
    missing: missingItem
  })));
  const warnings = items.flatMap((item) => item.warnings.map((warning) => ({
    milestone: item.milestone,
    path: item.path,
    warning
  })));
  const report = {
    schema: "create-milestone-check-report/v1",
    status: missing.length === 0 ? "passed" : "blocked",
    checkedAt: new Date().toISOString(),
    summary: {
      milestones: items.length,
      green: items.filter((item) => item.status === "green").length,
      red: items.filter((item) => item.status === "red").length,
      missing: missing.length,
      warnings: warnings.length
    },
    items,
    missing,
    warnings
  };
  writeFileSync(path.join(artifactsDir, "create-milestone-check.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function checkOverview(overviewPath, roadmap, dossier, options) {
  const body = readOptional(overviewPath);
  const rel = relative(overviewPath);
  const parts = toSlash(path.relative(paths.milestonesRoot, overviewPath)).split("/");
  const line = parts[0] ?? "";
  const slug = parts[1] ?? "";
  const rootTask = matchScalar(body, /-\s+\*\*Root task\*\*:\s*(.+)/u);
  const status = matchScalar(body, /-\s+\*\*状态\*\*:\s*(.+)|-\s+\*\*Status\*\*:\s*(.+)/u);
  const mission = matchScalar(body, /-\s+\*\*Mission\*\*:\s*(.+)/u);
  const decisionAnchors = [...body.matchAll(/\bdec_[A-Za-z0-9_]+\b/gu)].map((match) => match[0]);
  const missing = [];
  const warnings = [];
  if (!body.includes("milestone-map:v1") && !/(?:目标 \(North Star\)|North Star)/u.test(body)) missing.push("milestone-map:v1 marker");
  if (!status) missing.push("status field");
  if (!rootTask) missing.push("root task field");
  if (!mission && !/(?:目标 \(North Star\)|North Star)/u.test(body)) missing.push("mission field");
  if (!/(?:使用侧三问|Usage Questions)/u.test(body)) missing.push("usage questions section");
  if (!/(?:谁第一个用|First user)/u.test(body)) missing.push("usage question: first user");
  if (!/(?:何时强制切换|Forced switch)/u.test(body)) missing.push("usage question: forced switch");
  if (!/(?:旧路径何时废止|Retired old path)/u.test(body)) missing.push("usage question: retired old path");
  if (!/(?:任务映射|Task Mapping|W 波次总表|Wave Decomposition)/u.test(body)) missing.push("task mapping section");
  if (!/(?:依赖与入口|Dependencies|入口条件)/u.test(body)) missing.push("dependencies and entry section");
  if (options.requireDecisionAnchor && decisionAnchors.length === 0) missing.push("decision anchor");
  if (options.requireDecisionAnchor && decisionAnchors.length > 0 && !decisionAnchors.some((decisionId) => findDecision(decisionId))) {
    missing.push("decision anchor exists under decisions root");
  }

  const normalizedRoot = stripMarkdown(rootTask);
  if (/^task_/u.test(normalizedRoot) && !findTask(normalizedRoot)) missing.push(`root task ${normalizedRoot} exists under tasks root`);
  if (/^task_/u.test(normalizedRoot) && findChildTasks(normalizedRoot).length === 0) {
    warnings.push("子任务未 fan-out: create child tasks with `ha task create --parent <root>` and update the task mapping table.");
  }
  if (/\bfan-out pending\b/u.test(body)) {
    warnings.push("任务映射表仍包含 fan-out pending 占位行。");
  }
  if (!roadmapHasMilestone(roadmap, { rootTask: normalizedRoot, slug, title: titleFromBody(body) })) missing.push("00-roadmap.md row");
  if (!dossierHasMilestone(dossier, { line, rootTask: normalizedRoot, title: titleFromBody(body) })) missing.push("dossier-data.md row");

  return {
    status: missing.length === 0 ? "green" : "red",
    milestone: `${line}/${slug}`,
    path: rel,
    rootTask: normalizedRoot || null,
    decisionAnchors: [...new Set(decisionAnchors)].sort(),
    missing,
    warnings
  };
}

function renderOverview(input) {
  const waveRows = input.waves.length > 0
    ? input.waves.map((wave) => `| ${wave} | fan-out pending | planned | Run \`ha task create --title "${input.milestoneName} ${wave}" --vertical software/coding --preset standard-task --parent ${input.rootTaskId}\`, then replace this row with the child task id. |`).join("\n")
    : "| child | fan-out pending | planned | Run `ha task create --title \"<child title>\" --vertical software/coding --preset standard-task --parent <root task>` and replace this row. |";
  return `# ${input.milestoneName}\n\n<!-- milestone-map:v1 -->\n\n## 新模型映射\n\n- **状态**: ${input.status}\n- **Root task**: \`${input.rootTaskId}\`\n- **Mission**: ${input.mission}\n- **Decision 锚**: ${input.charterDecision}\n\n### 使用侧三问\n\n| 问题 | 答案 |\n| --- | --- |\n| 谁第一个用 | ${input.firstUser} |\n| 何时强制切换 | ${input.switchWhen} |\n| 旧路径何时废止 | ${input.retireWhen} |\n\n### 任务映射\n\n| 层级 | Task | 状态 | 说明 |\n| --- | --- | --- | --- |\n| root | \`${input.rootTaskId}\` | planned | milestone root task。 |\n${waveRows}\n\n### Fan-out 引导\n\n- 如果已知波次，创建时传入 \`--input waves=W0,W1,W2\` 会预填波次行。\n- 将每个 \`fan-out pending\` 行替换成真实子任务，例如 \`ha task create --title "${input.milestoneName} W0" --vertical software/coding --preset standard-task --parent ${input.rootTaskId}\`。\n- 子任务 fan out 后同步更新任务映射表。\n\n### 依赖与入口条件\n\n- ${input.dependencies}\n\n### PR/merge 运维\n\n- 全局 merge-health 运维台账：\`task_01KWYKCPG5FZA3AFVX9R8XX3B7\`（Authority: \`decision/dec_mrat6152\`）。\n- 治理文档：\`harness/governance/standards/merge-queue-troubleshooting-standard.md\`。\n- CEO / orchestrator 每合并一个 PR 即清理对应远端分支、本地分支和 worktree，并定期 sweep；worker 结构性不会替全局清理。\n- 同一 PR 两次入队仍合不进，先读全局台账 facts，再跑 \`npm run pr:doctor\`，处置后把事件、尝试和结论作为 fact/progress 落回全局台账。\n\n## 附录：执行记录\n\n- 子任务 fan out 后同步更新任务映射表。\n`;
}

function upsertRoadmapRow(filePath, input) {
  const row = `| ${input.milestoneName} | ${input.mission} | ${input.status} | ${input.dependencies} | \`${input.rootTaskId}\` |`;
  const header = "\n## create-milestone generated entries\n\n| Milestone | Mission | Status | Entry conditions | Root task anchor |\n| --- | --- | --- | --- | --- |\n";
  upsertMarkdownTableRow(filePath, row, header, input.rootTaskId);
}

function upsertDossierRow(filePath, input) {
  const row = `| ${input.line} | ${input.milestoneName} | ${input.status} | ${input.mission} | \`${input.rootTaskId}\` | 0 | ${input.dependencies} | new |\n`;
  const body = readOptional(filePath);
  if (!body) {
    writeFileSync(filePath, `# Milestone Dossier Data\n\n| Line | Milestone | Status | One-line goal | Root task id | Child count | Dependencies / entry | Batch |\n| --- | --- | --- | --- | --- | ---: | --- | --- |\n${row}`, "utf8");
    return;
  }
  if (body.includes(input.rootTaskId)) return;
  const marker = "\n## Open Dossier Notes";
  if (body.includes(marker)) {
    writeFileSync(filePath, body.replace(marker, `${row}${marker}`), "utf8");
  } else {
    writeFileSync(filePath, `${body.replace(/\s*$/u, "\n")}${row}`, "utf8");
  }
}

function upsertMarkdownTableRow(filePath, row, header, rootTaskId) {
  const body = readOptional(filePath);
  if (!body) {
    writeFileSync(filePath, `# Milestone Roadmap\n${header}${row}\n`, "utf8");
    return;
  }
  if (body.includes(rootTaskId)) return;
  const generatedHeading = "## create-milestone generated entries";
  if (body.includes(generatedHeading)) {
    writeFileSync(filePath, `${body.replace(/\s*$/u, "\n")}${row}\n`, "utf8");
  } else {
    writeFileSync(filePath, `${body.replace(/\s*$/u, "\n")}${header}${row}\n`, "utf8");
  }
}

function roadmapHasMilestone(body, input) {
  if (!body) return false;
  if (input.rootTask && input.rootTask !== "none" && body.includes(input.rootTask)) return true;
  return Boolean(input.title && body.toLowerCase().includes(input.title.toLowerCase()));
}

function dossierHasMilestone(body, input) {
  if (!body) return false;
  if (input.rootTask && input.rootTask !== "none" && body.includes(input.rootTask)) return true;
  return Boolean(input.line && input.title && body.includes(`| ${input.line} |`) && body.toLowerCase().includes(input.title.toLowerCase()));
}

function findTask(taskId) {
  const fromContext = (Array.isArray(context.taskIndex) ? context.taskIndex : []).find((task) => task.taskId === taskId);
  if (fromContext) return fromContext;
  for (const indexPath of walk(paths.tasksRoot).filter((filePath) => path.basename(filePath) === "INDEX.md")) {
    const body = readOptional(indexPath);
    const foundTaskId = matchScalar(body, /task_id:\s*"?([^"\n]+)"?/u);
    if (foundTaskId !== taskId) continue;
    return {
      taskId,
      title: matchScalar(body, /title:\s*"?([^"\n]+)"?/u),
      taskPlanSummary: summarizeMarkdown(readOptional(path.join(path.dirname(indexPath), "task_plan.md")))
    };
  }
  return undefined;
}

function findChildTasks(parentTaskId) {
  return walk(paths.tasksRoot).filter((filePath) => path.basename(filePath) === "INDEX.md").flatMap((indexPath) => {
    const body = readOptional(indexPath);
    const parent = matchScalar(body, /parent:\s*"?([^"\n]+)"?/u);
    if (parent !== parentTaskId) return [];
    const taskId = matchScalar(body, /task_id:\s*"?([^"\n]+)"?/u);
    return taskId ? [taskId] : [];
  });
}

function findDecision(decisionId) {
  return decisionDocuments().some((decision) => decision.decisionId === decisionId);
}

function decisionDocuments() {
  return walk(paths.decisionsRoot).filter((filePath) => path.basename(filePath) === "decision.md").map((filePath) => {
    const body = readOptional(filePath);
    return {
      decisionId: matchScalar(body, /decision_id:\s*"?([^"\n]+)"?/u) || path.basename(path.dirname(filePath)).replace(/^decision-/u, ""),
      path: filePath
    };
  });
}

function requiredSlugInput(name) {
  const value = optionalInput(name);
  if (!value) fail("missing_input", `Input ${name} is required. Use script run with --input ${name}=...`);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(value)) fail("invalid_input", `Input ${name} must be a lowercase slug.`);
  return value;
}

function requiredDecisionInput(name) {
  const value = optionalInput(name);
  if (!value) fail("missing_input", `Input ${name} is required. Charter decisions are created by the CEO and must be passed as dec_*.`);
  if (!/^dec_[A-Za-z0-9_]+$/u.test(value)) fail("invalid_input", `Input ${name} must be a dec_* id.`);
  return value;
}

function optionalInput(name) {
  const value = String(inputs[name] ?? "").trim();
  return value && !/^\{\{.+\}\}$/u.test(value) ? value : "";
}

function parseListInput(name) {
  return optionalInput(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function titleFromBody(body) {
  const match = /^#\s+(.+)$/mu.exec(body);
  return match ? match[1].replace(/\s*[·-].*$/u, "").trim() : "";
}

function matchScalar(body, regex) {
  const match = regex.exec(body);
  if (!match) return "";
  return String(match[1] ?? match[2] ?? "").trim();
}

function stripMarkdown(value) {
  return String(value ?? "").replace(/[`*]/gu, "").trim();
}

function walk(root) {
  if (!root || !existsSync(root)) return [];
  const stats = statSync(root);
  if (stats.isFile()) return [root];
  if (!stats.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

function readOptional(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function summarizeMarkdown(body) {
  return body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("---") && !line.startsWith("|"))
    .slice(0, 2)
    .join(" ");
}

function fail(code, hint) {
  writeResult({
    ok: false,
    report: {
      schema: "create-milestone-error-report/v1",
      entrypoint,
      code,
      hint
    },
    error: {
      code: "preset_script_result_failed",
      hint
    }
  });
  process.exit(0);
}

function writeResult(result) {
  writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
    schema: "script-result/v1",
    ...result
  }, null, 2)}\n`, "utf8");
}

function relative(filePath) {
  return toSlash(path.relative(paths.rootDir ?? process.cwd(), filePath));
}

function toSlash(value) {
  return value.split(path.sep).join("/");
}
