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
const policy = context.policy?.presetId === "create-milestone" ? context.policy : null;
const publicRequiredArtifacts = [
  { id: "overview", role: "overview", root: "milestones", path: "{{line}}/{{slug}}/overview.md" },
  { id: "index", role: "index", root: "milestones", path: "milestones-index.md" },
  { id: "machine-summary", role: "machine-summary", root: "milestones", path: "milestones-summary.md" }
];
const publicOptionalHtml = { id: "html", role: "html", root: "milestones", path: "milestones.html" };
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
  const charterDecision = resolveCharterDecision();
  const rootTaskId = String(context.taskId ?? "").trim();
  if (!rootTaskId) fail("missing_root_task", "Task context is required.");
  const rootTask = findTask(rootTaskId);
  if (!rootTask) fail("missing_root_task", `Root task ${rootTaskId} was not found in the task index context.`);

  const milestoneName = optionalInput("milestoneName") || rootTask.title || slug;
  const mission = optionalInput("mission") || rootTask.taskPlanSummary || `Deliver ${milestoneName}.`;
  const status = optionalInput("status") || "planned";
  const firstUser = optionalInput("firstUser") || "TBD";
  const switchWhen = optionalInput("switchWhen") || "TBD";
  const retireWhen = optionalInput("retireWhen") || "TBD";
  const dependencies = optionalInput("dependencies") || "TBD";
  const waves = parseListInput("waves");

  const contract = requiredArtifacts();
  const overviewPath = resolveArtifactPath(artifactForRole(contract, "overview"), { line, slug });
  const milestoneDir = path.dirname(overviewPath);
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

  const roadmapPath = resolveArtifactPath(artifactForRole(contract, "index"), { line, slug });
  const dossierPath = resolveArtifactPath(artifactForRole(contract, "machine-summary"), { line, slug });
  mkdirSync(path.dirname(roadmapPath), { recursive: true });
  mkdirSync(path.dirname(dossierPath), { recursive: true });
  upsertRoadmapRow(roadmapPath, { line, slug, milestoneName, mission, status, dependencies, rootTaskId });
  upsertDossierRow(dossierPath, { line, milestoneName, mission, status, dependencies, rootTaskId });
  const htmlArtifact = contract.find((artifact) => artifact.role === "html");
  const htmlResult = htmlArtifact
    ? renderMilestoneDossierHtml({
      paths,
      artifactsDir,
      sourcePath: dossierPath,
      outputPath: resolveArtifactPath(htmlArtifact, { line, slug })
    })
    : undefined;

  const report = buildCheckReport({ line, slug });
  writeResult({
    ok: report.status === "passed",
    report: {
      schema: "create-milestone-scaffold-report/v1",
      status: report.status,
      rootTaskId,
      milestone: { line, slug, path: relative(overviewPath) },
      charterDecision,
      generatedMilestoneFiles: [relative(overviewPath), relative(roadmapPath), relative(dossierPath), htmlResult?.path].filter(Boolean),
      html: htmlResult ?? null,
      check: report
    },
    error: report.status === "passed" ? undefined : {
      code: "preset_script_result_failed",
      hint: "create-milestone scaffold produced an incomplete milestone surface."
    }
  });
}

function runRenderHtml() {
  const contract = requiredArtifacts();
  const summaryArtifact = artifactForRole(contract, "machine-summary");
  const htmlArtifact = contract.find((artifact) => artifact.role === "html") ?? publicOptionalHtml;
  const htmlResult = renderMilestoneDossierHtml({
    paths,
    artifactsDir,
    sourcePath: resolveArtifactPath(summaryArtifact, {}),
    outputPath: resolveArtifactPath(htmlArtifact, {})
  });
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
  const report = buildCheckReport({ line, slug });
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
  const contract = requiredArtifacts();
  const overviewArtifact = artifactForRole(contract, "overview");
  const milestoneRoots = options.line && options.slug
    ? [resolveArtifactPath(overviewArtifact, options)]
    : walk(paths.milestonesRoot).filter((filePath) => artifactPathMatches(overviewArtifact, filePath));
  const items = milestoneRoots.map((overviewPath) => checkOverview(overviewPath, contract));
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
    contract: {
      source: policy ? "policy" : "public-default",
      requiredArtifacts: contract,
      optionalArtifacts: contract.some((artifact) => artifact.role === "html") ? [] : [publicOptionalHtml]
    },
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

function checkOverview(overviewPath, contract) {
  const body = readOptional(overviewPath);
  const rel = relative(overviewPath);
  const parts = toSlash(path.relative(paths.milestonesRoot, overviewPath)).split("/");
  const line = parts[0] ?? "";
  const slug = parts[1] ?? "";
  const rootTask = matchScalar(body, /-\s+\*\*Root task\*\*:\s*(.+)/u);
  const status = matchScalar(body, /-\s+\*\*状态\*\*:\s*(.+)|-\s+\*\*Status\*\*:\s*(.+)/u);
  const mission = matchScalar(body, /-\s+\*\*Mission\*\*:\s*(.+)/u);
  const charterAnchor = stripMarkdown(matchScalar(body, /-\s+\*\*(?:Approval anchor|Decision 锚)\*\*:\s*(.+)/u));
  const anchorRule = policy?.rules?.charterAnchor;
  const decisionAnchors = charterAnchor ? extractDecisionAnchorTokens(charterAnchor) : [];
  const anchorIdPattern = anchorRule ? new RegExp(anchorRule.idPattern, "u") : null;
  const hasValidAnchorTokens = decisionAnchors.length > 0
    && (!anchorIdPattern || decisionAnchors.every((anchor) => anchorIdPattern.test(anchor)));
  const grandfathered = (anchorRule?.grandfatheredMilestoneSlugs ?? []).includes(slug);
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
  if (anchorRule?.required && !grandfathered && !charterAnchor) missing.push("approval anchor");
  if (charterAnchor && anchorRule && !hasValidAnchorTokens) {
    missing.push("approval anchor matches policy idPattern");
  }
  if (charterAnchor && hasValidAnchorTokens && anchorRule?.entityType === "decision"
    && decisionAnchors.some((anchor) => !findDecision(anchor))) {
    missing.push("approval anchor exists under decisions root");
  }

  const normalizedRoot = stripMarkdown(rootTask);
  if (/^task_/u.test(normalizedRoot) && !findTask(normalizedRoot)) missing.push(`root task ${normalizedRoot} exists under tasks root`);
  if (/^task_/u.test(normalizedRoot) && findChildTasks(normalizedRoot).length === 0) {
    warnings.push("子任务未 fan-out: create child tasks with `ha task create --parent <root>` and update the task mapping table.");
  }
  if (/\bfan-out pending\b/u.test(body)) {
    warnings.push("任务映射表仍包含 fan-out pending 占位行。");
  }
  const artifactChecks = checkRequiredArtifacts(contract, {
    line,
    slug,
    rootTask: normalizedRoot,
    title: titleFromBody(body),
    overviewPath,
    overviewBody: body
  });
  missing.push(...artifactChecks.missing);

  if (!contract.some((artifact) => artifact.role === "html")) {
    const htmlPath = resolveArtifactPath(publicOptionalHtml, { line, slug });
    const htmlBody = readOptional(htmlPath);
    if (htmlBody && !artifactHasMilestone(htmlBody, { line, rootTask: normalizedRoot, title: titleFromBody(body) })) {
      missing.push(`optional html milestone entry (${relative(htmlPath)})`);
    }
  }

  return {
    status: missing.length === 0 ? "green" : "red",
    milestone: `${line}/${slug}`,
    path: rel,
    rootTask: normalizedRoot || null,
    decisionAnchors: [...new Set(decisionAnchors)].sort(),
    artifacts: artifactChecks.items,
    missing,
    warnings
  };
}

function extractDecisionAnchorTokens(value) {
  return value.match(/(?<![A-Za-z0-9_])dec_[^,、，/／;；\s()[\]{}（）<>《》:：.!?。！？]+/gu) ?? [];
}

function renderOverview(input) {
  const waveRows = input.waves.length > 0
    ? input.waves.map((wave) => `| ${wave} | fan-out pending | planned | Run \`ha task create --title "${input.milestoneName} ${wave}" --vertical software/coding --preset standard-task --parent ${input.rootTaskId}\`, then replace this row with the child task id. |`).join("\n")
    : "| child | fan-out pending | planned | Run `ha task create --title \"<child title>\" --vertical software/coding --preset standard-task --parent <root task>` and replace this row. |";
  const anchorLine = input.charterDecision ? `\n- **Approval anchor**: ${input.charterDecision}` : "";
  const references = (policy?.rules?.additionalReferences ?? []).map((reference) =>
    `- **${reference.label}** (${reference.kind}): \`${reference.ref}\``
  );
  const referencesSection = references.length > 0
    ? `\n\n### Project references\n\n${references.join("\n")}`
    : "";
  return `# ${input.milestoneName}\n\n<!-- milestone-map:v1 -->\n\n## 新模型映射\n\n- **状态**: ${input.status}\n- **Root task**: \`${input.rootTaskId}\`\n- **Mission**: ${input.mission}${anchorLine}\n\n### 使用侧三问\n\n| 问题 | 答案 |\n| --- | --- |\n| 谁第一个用 | ${input.firstUser} |\n| 何时强制切换 | ${input.switchWhen} |\n| 旧路径何时废止 | ${input.retireWhen} |\n\n### 任务映射\n\n| 层级 | Task | 状态 | 说明 |\n| --- | --- | --- | --- |\n| root | \`${input.rootTaskId}\` | planned | milestone root task。 |\n${waveRows}\n\n### Fan-out 引导\n\n- 如果已知波次，创建时传入 \`--input waves=W0,W1,W2\` 会预填波次行。\n- 将每个 \`fan-out pending\` 行替换成真实子任务，例如 \`ha task create --title "${input.milestoneName} W0" --vertical software/coding --preset standard-task --parent ${input.rootTaskId}\`。\n- 子任务 fan out 后同步更新任务映射表。\n\n### 依赖与入口条件\n\n- ${input.dependencies}${referencesSection}\n\n## 附录：执行记录\n\n- 子任务 fan out 后同步更新任务映射表。\n`;
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

function artifactHasMilestone(body, input) {
  if (!body) return false;
  if (input.rootTask && input.rootTask !== "none" && body.includes(input.rootTask)) return true;
  return Boolean(input.title && body.toLowerCase().includes(input.title.toLowerCase()));
}

function checkRequiredArtifacts(contract, input) {
  const missing = [];
  const items = contract.map((artifact) => {
    const artifactPath = resolveArtifactPath(artifact, input);
    const body = artifactPath === input.overviewPath ? input.overviewBody : readOptional(artifactPath);
    let status = body ? "present" : "missing";
    if (!body) {
      missing.push(`${artifact.id} (${relative(artifactPath)})`);
    } else if (["index", "machine-summary", "html"].includes(artifact.role) && !artifactHasMilestone(body, input)) {
      status = "missing-milestone-entry";
      missing.push(`${artifact.id} milestone entry (${relative(artifactPath)})`);
    }
    return {
      id: artifact.id,
      role: artifact.role,
      path: relative(artifactPath),
      status
    };
  });
  return { items, missing };
}

function requiredArtifacts() {
  const configured = policy?.rules?.requiredArtifacts;
  return Array.isArray(configured) ? configured.map((artifact) => ({ ...artifact })) : publicRequiredArtifacts;
}

function artifactForRole(contract, role) {
  const artifact = contract.find((candidate) => candidate.role === role);
  if (!artifact) fail("invalid_policy_contract", `create-milestone artifact contract is missing role ${role}.`);
  return artifact;
}

function resolveArtifactPath(artifact, values) {
  const root = artifact.root === "task" ? outputRoot : paths.milestonesRoot;
  const rendered = String(artifact.path)
    .replaceAll("{{line}}", String(values.line ?? ""))
    .replaceAll("{{slug}}", String(values.slug ?? ""));
  if (/\{\{.+\}\}/u.test(rendered)) fail("invalid_policy_contract", `Artifact ${artifact.id} has unresolved path placeholders.`);
  const resolved = path.resolve(root, rendered);
  const relativePath = path.relative(root, resolved);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    fail("invalid_policy_contract", `Artifact ${artifact.id} resolves outside ${artifact.root} root.`);
  }
  return resolved;
}

function artifactPathMatches(artifact, filePath) {
  if (artifact.root !== "milestones") return false;
  const relativePath = toSlash(path.relative(paths.milestonesRoot, filePath));
  const pattern = toSlash(artifact.path)
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("\\{\\{line\\}\\}", "[^/]+")
    .replaceAll("\\{\\{slug\\}\\}", "[^/]+");
  return new RegExp(`^${pattern}$`, "u").test(relativePath);
}

function findTask(taskId) {
  const fromContext = (Array.isArray(context.taskIndex) ? context.taskIndex : []).find((task) => task.taskId === taskId);
  if (fromContext) return fromContext;
  for (const indexPath of declaredTaskIndexPaths()) {
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
  if (Array.isArray(context.taskIndex)) {
    return context.taskIndex
      .filter((task) => task.parent === parentTaskId)
      .map((task) => task.taskId)
      .filter(Boolean);
  }
  return declaredTaskIndexPaths().flatMap((indexPath) => {
    const body = readOptional(indexPath);
    const parent = matchScalar(body, /parent:\s*"?([^"\n]+)"?/u);
    if (parent !== parentTaskId) return [];
    const taskId = matchScalar(body, /task_id:\s*"?([^"\n]+)"?/u);
    return taskId ? [taskId] : [];
  });
}

function declaredTaskIndexPaths() {
  return [...new Set((Array.isArray(context.readScopes) ? context.readScopes : [])
    .filter((scope) => isSameOrInside(paths.tasksRoot, scope))
    .flatMap((scope) => walk(scope))
    .filter((filePath) => path.basename(filePath) === "INDEX.md"))].sort();
}

function isSameOrInside(root, candidate) {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function findDecision(decisionId) {
  return decisionDocuments().some((decision) => decision.decisionId === decisionId);
}

function decisionDocuments() {
  if (Array.isArray(context.decisions)) return context.decisions;
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

function resolveCharterDecision() {
  const value = optionalInput("charterDecision");
  const rule = policy?.rules?.charterAnchor;
  if (!value && rule?.required) fail("missing_input", "Input charterDecision is required by the project policy.");
  if (!value) return "";
  if (rule && !new RegExp(rule.idPattern, "u").test(value)) {
    fail("invalid_input", "Input charterDecision does not match the project policy idPattern.");
  }
  if (rule?.entityType === "decision" && !findDecision(value)) {
    fail("missing_charter_decision", `Charter decision ${value} was not found under decisions root.`);
  }
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
