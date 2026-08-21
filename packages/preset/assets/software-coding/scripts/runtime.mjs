import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const assetRoot = path.resolve(import.meta.dirname, "..");

export async function run(expectedId) {
  const context = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
  if (context.schema !== "vertical-script-context/v1" || context.scriptId !== expectedId) throw new Error("invalid vertical script context");
  await waitAtTestBlocker();
  const result = handlers[expectedId](context); process.stdout.write(`${JSON.stringify({ schema: "vertical-script-plan/v1", scriptId: expectedId, warnings: [], ...result })}\n`);
}

async function waitAtTestBlocker() {
  const blocker = process.env.HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE; if (!blocker) return;
  writeFileSync(`${blocker}.started`, `${process.pid}\n`, "utf8");
  while (existsSync(blocker)) await new Promise((resolve) => setTimeout(resolve, 10));
}

const handlers = {
  "vertical:software-coding:architecture-init": architectureInit,
  "vertical:software-coding:architecture-snapshot": architectureSnapshot,
  "vertical:software-coding:architecture-check": architectureCheck,
  "vertical:software-coding:repository-audit": repositoryAudit,
  "vertical:software-coding:adr-seed": adrSeed,
  "vertical:software-coding:adr-render": adrRender,
  "vertical:software-coding:decision-conformance": decisionConformance
};

function architectureInit(context) {
  const templates = [["architecture-manifest.json", "repository.architecture.manifest/en-US.txt"], ["model/likec4.config.json", "repository.architecture.likec4.config/en-US.txt"], ["model/specification.c4", "repository.architecture.likec4.specification/en-US.txt"], ["model/model.c4", "repository.architecture.likec4.model/en-US.txt"], ["model/views/landscape.c4", "repository.architecture.likec4.view.landscape/en-US.txt"], ["model/views/write-path.c4", "repository.architecture.likec4.view.write-path/en-US.txt"], ["model/views/runtime.c4", "repository.architecture.likec4.view.runtime/en-US.txt"]];
  return scaffold(context, templates.map(([target, source]) => [path.join(context.outputRoot, "architecture", target), template(source)]), "architecture-scaffold");
}

function architectureSnapshot(context) {
  if (!context.taskId) return failed("task-required", { message: "architecture-snapshot requires taskId" });
  const root = path.join(context.paths.contextRoot, "architecture"), manifest = path.join(root, "architecture-manifest.json"); if (!existsSync(manifest)) return failed("not-configured", { configured: false });
  const files = walk(root).map((file) => ({ path: slash(path.relative(root, file)), sha256: sha(readFileSync(file)), size: statSync(file).size })), body = `${JSON.stringify({ schema: "architecture-snapshot/v1", sourceCommitSha: context.repository.commitSha, files, digest: `sha256:${sha(JSON.stringify(files))}` }, null, 2)}\n`;
  return generated(context, path.join(context.outputRoot, "artifacts/architecture/code-facts.json"), body, "application/json", { fileCount: files.length });
}

function architectureCheck(context) {
  if (!context.taskId) return failed("task-required", { message: "architecture-check requires taskId" });
  const manifest = path.join(context.paths.contextRoot, "architecture/architecture-manifest.json"), snapshot = path.join(context.outputRoot, "artifacts/architecture/code-facts.json"); if (!existsSync(manifest)) return success("not-configured", { configured: false }, []);
  if (!existsSync(snapshot)) return success("snapshot-missing", { configured: true, snapshot: false }, []);
  try { const parsed = JSON.parse(readFileSync(snapshot, "utf8")); return success(parsed.sourceCommitSha === context.repository.commitSha ? "fresh" : "stale", { configured: true, snapshot: true, sourceCommitSha: parsed.sourceCommitSha, currentCommitSha: context.repository.commitSha }, []); } catch { return failed("snapshot-invalid", { configured: true, snapshot: true }); }
}

function repositoryAudit() {
  const vertical = JSON.parse(readFileSync(path.join(assetRoot, "vertical.json"), "utf8")), catalog = JSON.parse(readFileSync(path.join(assetRoot, "template-catalog.json"), "utf8")), missing = vertical.scripts.filter(({ command }) => !existsSync(path.join(assetRoot, command))).map(({ id }) => id);
  return success(missing.length ? "invalid" : "conformant", { verticalId: vertical.id, scriptCount: vertical.scripts.length, templateCount: catalog.documents.length, missingCommands: missing }, [] , missing.length === 0);
}

function adrSeed(context) {
  const locale = context.inputs.locale === "zh-CN" ? "zh-CN" : "en-US", templates = [[path.join(context.paths.adrRoot, "README.md"), template(`repository.adr.index/${locale}.md`)], [path.join(context.paths.adrRoot, "0000-template.md"), template(`repository.adr.template/${locale}.md`)]];
  return scaffold(context, templates, "adr-scaffold");
}

function adrRender(context) {
  const decisionId = context.inputs.decisionId; if (!decisionId || !/^[A-Za-z0-9_-]+$/u.test(decisionId)) return failed("decision-required", { message: "adr-render requires inputs.decisionId" });
  const source = path.join(context.paths.decisionsRoot, `decision-${decisionId}`, "decision.md"); if (!existsSync(source)) return failed("decision-not-found", { decisionId });
  const canonical = readFileSync(source, "utf8"), title = canonical.match(/^#\s+(.+)$/mu)?.[1] ?? decisionId, state = canonical.match(/^state:\s*(\S+)/mu)?.[1] ?? "unknown", body = `# ADR ${decisionId}: ${title}\n\n## Status\n\n${state}\n\n## Context\n\nDerived from canonical decision \`${decisionId}\`.\n\n## Decision\n\nSee \`decisions/decision-${decisionId}/decision.md\`; canonical decision content is not duplicated here.\n\n## Consequences\n\nTrack implementation and evidence through the canonical task lifecycle.\n`;
  return generated(context, path.join(context.paths.adrRoot, `${decisionId}.md`), body, "text/markdown", { decisionId, sourceSha256: `sha256:${sha(canonical)}` });
}

function decisionConformance(context) {
  const decisions = existsSync(context.paths.decisionsRoot) ? readdirSync(context.paths.decisionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("decision-")).map((entry) => path.join(context.paths.decisionsRoot, entry.name, "decision.md")).filter(existsSync).sort() : [], tasks = existsSync(context.paths.tasksRoot) ? readdirSync(context.paths.tasksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length : 0, states = decisions.map((file) => readFileSync(file, "utf8").match(/^state:\s*(\S+)/mu)?.[1] ?? "unknown"), issues = states.flatMap((state, index) => state === "proposed" ? [{ code: "proposed-decision", path: slash(path.relative(context.paths.authoredRoot, decisions[index])) }] : []);
  return success(issues.length ? "attention-required" : "conformant", { taskCount: tasks, decisionCount: decisions.length, states: Object.fromEntries([...new Set(states)].sort().map((state) => [state, states.filter((item) => item === state).length])), issues }, []);
}

function scaffold(context, entries, kind) { const conflicts = entries.filter(([target, body]) => existsSync(target) && readFileSync(target, "utf8") !== body).map(([target]) => relative(context, target)); if (conflicts.length) return failed("conflict", { kind, conflicts }); const changes = entries.filter(([target]) => !existsSync(target)).map(([target, body]) => change(context, target, body, target.endsWith(".json") ? "application/json" : target.endsWith(".md") ? "text/markdown" : "text/plain", "create")); return success(changes.length ? "planned" : "unchanged", { kind, documentCount: entries.length, changeCount: changes.length }, changes); }
function generated(context, target, body, mediaType, report) { const disposition = existsSync(target) ? "replace" : "create", changes = existsSync(target) && readFileSync(target, "utf8") === body ? [] : [change(context, target, body, mediaType, disposition)]; return success(changes.length ? "planned" : "unchanged", report, changes); }
function change(context, target, body, mediaType, disposition) { return { path: relative(context, target), body, mediaType, disposition }; }
function relative(context, target) { return slash(path.relative(context.paths.authoredRoot, target)); }
function success(status, report, changes, ok = true) { return { ok, status, report, changes }; }
function failed(status, report) { return success(status, report, [], false); }
function template(relativePath) { return readFileSync(path.join(assetRoot, "templates", relativePath), "utf8"); }
function walk(root) { if (!existsSync(root)) return []; return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isSymbolicLink() ? [] : entry.isDirectory() ? walk(path.join(root, entry.name)) : entry.isFile() ? [path.join(root, entry.name)] : []).sort(); }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function slash(value) { return value.split(path.sep).join("/"); }
