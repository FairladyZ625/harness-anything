#!/usr/bin/env node
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { deriveRelationId, readColdRebuildSource, readFrontmatter } from "../packages/kernel/src/index.ts";

const decisionRepairs = Object.freeze([
  repair("dec_LEDGER_E11", "AZ2", "RJ2", "6 港端口设计(Lifecycle/Evidence/Assignment/Runtime...)", "E11 已把 BindingIndex 归并回三端口合同;6 港端口是过度切分,会把端口语义重新碎片化。"),
  repair("dec_LEDGER_E21", "AZ7", "RJ2", "full-cutover 作为未来产品策略或 dogfood gate", "2026-06-14 用户裁决退役 full-cutover;E21 已把它保留为 M2 历史证据,后续由 Legacy Intake + forward-only dogfood 取代。"),
  repair("dec_LEDGER_E29", "AZ8", "RJ2", "preset/template 删除机制", "2026-06-14 用户裁决砍掉删除机制;E29 保持 Vertical 最小核心,Preset 只做叠加而不引入删除语义。"),
  repair("dec_LEDGER_E30", "AZ9", "RJ2", "M2.5 实现 parent/child、DAG、task tree 或 --parent", "E30 已把 parent/child/DAG/task-tree 判给 PLT-TaskTree;M2.5/M5 不抢关系层产品化。"),
  repair("dec_LEDGER_E33", "AZ12", "RJ2", "V1+V2 GUI 捆绑在 GUI-V2 同一里程碑交付", "E33 已把 GUI-V1 独立为不依赖 PLT-TaskTree/PLT-Adapter/PLT-CrossRepo 的可交付;V1+V2 捆绑会人为延迟数月,复活需新 ADR + 用户确认。"),
  repair("dec_LEDGER_E35", "AZ1", "RJ2", "双生命周期 + 分层同步 + drift/gate(旧 dossier 路线)", "维护两套状态机一致性本质无解;E35 三元语内核把 task/decision/fact 拆成不同原语,使旧 dossier 双生命周期路线在数据模型上不可表达。"),
  repair("dec_LEDGER_E35", "AZ6", "RJ3", "WorkItem 替代 Task 作内核词", "别人的状态机叫什么不应污染内核词汇;E35 保留 task 作为执行原语,并把 decision/fact 独立出来。"),
  repair("dec_LEDGER_E48", "AZ11", "RJ2", "Requirement 一等实体化", "E48 将内核原语限定为 task/decision/fact + relation,PRD/Requirement 类场景名词留在 vertical/composite 层;PRD 内部结构足够,避免文档爆炸。"),
  repair("dec_LEDGER_E51", "AZ13", "RJ2", "把 relation 边内嵌进 decision frontmatter(supportedBy 字段)", "E42/E44 否决强类型内嵌 supportedBy 字段;E51 修订为 owner frontmatter 的通用 typed relations: record + projection 派生边表,不是独立 relation 文件,也不是 supportedBy 字段。"),
  repair("dec_LEDGER_E53", "AZ10", "RJ2", "全局 RolePack/ContextPack/pack build", "E53 把上下文不遗漏落到 scope + mandatory read-set + projection-derived context map;dispatch 上下文应由 orchestrator prompt 与模板片段组成,不是全局 pack build。"),
  repair("dec_LEDGER_E59", "AZ3", "RJ2", "任意时刻一个 active 引擎 + 受控 rebind/migrate", "外部引擎基于数据库,目标库无记录时迁移挂空气;E59 选择生命周期 seam/LocalLifecycleEngine,不承诺 provider-neutral active-engine 迁移。"),
  repair("dec_LEDGER_E59", "AZ4", "RJ3", "statusMapping 归 Vertical(可下推 Preset)", "N x M 状态映射会爆炸;E59 的 seam split 把 lifecycle 状态映射归引擎属性,不是 vertical/preset 属性。"),
  repair("dec_LEDGER_E59", "AZ5", "RJ4", "抽象语义桶作为互译语", "抽象语义桶会形成无人实现的第三套词汇;E59 采用 local 词表与 provider snapshot,不引入额外中间语言。")
]);
const relationRepair = Object.freeze({
  decisionId: "dec_01KXK67KRDAP21CQR855V566BH",
  oldId: "rel_1a43d3d0a6d15f52",
  newId: "rel_bb4aec75f0cbf1d7",
  source: "decision/dec_01KXK67KRDAP21CQR855V566BH/CH1",
  oldTarget: "decision/dec_01KXHS6A",
  newTarget: "decision/dec_01KXHS6A84NEDB77Q1ASGQQ1DT",
  type: "narrows",
  strength: "strong",
  direction: "directed",
  origin: "declared",
  rationale: "界定 dec_01KXHS6A 能力模型的适用边界：v3 能力只用于 gate-fed headless 脚本，指引类 preset 用 agent 自身权限、不需要 capability/grant。",
  state: "active"
});

export function repairMigrationImportSource(rootInput, write = false) {
  const root = realpathSync(path.resolve(rootInput));
  assertFile(path.join(root, "harness/harness.yaml"));
  const originals = new Map(), candidates = new Map();
  assertNoAzReferences(root);
  for (const item of decisionRepairs) {
    const file = decisionPath(root, item.decisionId), body = candidates.get(file) ?? read(file);
    originals.set(file, originals.get(file) ?? body);
    candidates.set(file, replaceRejectedId(body, item));
  }
  const relationFile = decisionPath(root, relationRepair.decisionId), relationBody = candidates.get(relationFile) ?? read(relationFile);
  originals.set(relationFile, originals.get(relationFile) ?? relationBody);
  candidates.set(relationFile, replaceRelation(relationBody));
  assertCandidatePostconditions(candidates);
  if (write) {
    for (const [file, body] of [...candidates].sort(([left], [right]) => left.localeCompare(right))) writeFileSync(file, body, "utf8");
    assertWrittenSource(root);
  }
  return {
    schema: "migration-import-source-repair/v1",
    mode: write ? "write" : "dry-run",
    root,
    changedFiles: candidates.size,
    rejectedOptionRepairs: decisionRepairs.map(({ decisionId, from, to }) => ({ decisionId, from, to })),
    relationRepair: { from: relationRepair.oldId, to: relationRepair.newId, target: relationRepair.newTarget }
  };
}

function repair(decisionId, from, to, text, whyNot) { return Object.freeze({ decisionId, from, to, text, whyNot }); }
function decisionPath(root, decisionId) { return path.join(root, `harness/decisions/decision-${decisionId}/decision.md`); }
function read(file) { assertFile(file); return readFileSync(file, "utf8"); }
function assertFile(file) { if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`required file is missing: ${file}`); }

function replaceRejectedId(body, item) {
  const frontmatter = readFrontmatter(body);
  if (frontmatter === null) throw new Error(`${item.decisionId} has no frontmatter`);
  const rejected = frontmatterBlock(frontmatter, "rejected");
  const oldToken = `id: ${JSON.stringify(item.from)}`, newToken = `id: ${JSON.stringify(item.to)}`;
  const oldLines = rejected.split(/\r?\n/u).filter((line) => line.includes(oldToken));
  if (oldLines.length !== 1) throw new Error(`${item.decisionId} expected exactly one ${item.from} rejected option, found ${oldLines.length}`);
  if (rejected.includes(newToken)) throw new Error(`${item.decisionId} already contains target id ${item.to}`);
  const line = oldLines[0];
  if (!line.includes(`text: ${JSON.stringify(item.text)}`) || !line.includes(`why_not: ${JSON.stringify(item.whyNot)}`)) throw new Error(`${item.decisionId}/${item.from} semantic fingerprint changed`);
  const occurrences = body.split(oldToken).length - 1;
  if (occurrences !== 1) throw new Error(`${item.decisionId} expected one exact ${item.from} token, found ${occurrences}`);
  return body.replace(oldToken, newToken);
}

function replaceRelation(body) {
  const line = body.split(/\r?\n/u).filter((row) => row.includes(`relation_id: ${JSON.stringify(relationRepair.oldId)}`));
  if (line.length !== 1) throw new Error(`expected exactly one ${relationRepair.oldId} record, found ${line.length}`);
  for (const field of ["source", "oldTarget", "type", "strength", "direction", "origin", "rationale", "state"]) {
    const key = field === "oldTarget" ? "target" : field;
    if (!line[0].includes(`${key}: ${JSON.stringify(relationRepair[field])}`)) throw new Error(`${relationRepair.oldId} ${key} fingerprint changed`);
  }
  const derived = deriveRelationId({ source: relationRepair.source, target: relationRepair.newTarget, type: relationRepair.type, direction: relationRepair.direction });
  if (derived !== relationRepair.newId) throw new Error(`replacement relation id drifted: expected ${relationRepair.newId}, derived ${derived}`);
  if (body.includes(relationRepair.newId) || body.includes(`target: ${JSON.stringify(relationRepair.newTarget)}`)) throw new Error("replacement relation already exists");
  return body
    .replace(`relation_id: ${JSON.stringify(relationRepair.oldId)}`, `relation_id: ${JSON.stringify(relationRepair.newId)}`)
    .replace(`target: ${JSON.stringify(relationRepair.oldTarget)}`, `target: ${JSON.stringify(relationRepair.newTarget)}`);
}

function assertNoAzReferences(root) {
  const pattern = /decision\/dec_LEDGER_E(?:11|21|29|30|33|35|48|51|53|59)\/AZ\d+/u;
  const hits = migrationInputFiles(root).filter((file) => pattern.test(readFileSync(file, "utf8")));
  if (hits.length) throw new Error(`AZ anchor references must be repaired together before renumbering: ${hits.join(", ")}`);
}

function assertCandidatePostconditions(candidates) {
  for (const item of decisionRepairs) {
    const body = candidates.get(decisionPathFromCandidates(candidates, item.decisionId));
    if (!body || body.includes(`id: ${JSON.stringify(item.from)}`) || body.split(`id: ${JSON.stringify(item.to)}`).length !== 2) throw new Error(`${item.decisionId} candidate id postcondition failed`);
  }
  const relationBody = candidates.get(decisionPathFromCandidates(candidates, relationRepair.decisionId));
  if (!relationBody || relationBody.includes(relationRepair.oldId) || relationBody.includes(`target: ${JSON.stringify(relationRepair.oldTarget)}`) || !relationBody.includes(relationRepair.newId) || !relationBody.includes(`target: ${JSON.stringify(relationRepair.newTarget)}`)) throw new Error("relation candidate postcondition failed");
}

function decisionPathFromCandidates(candidates, decisionId) { return [...candidates.keys()].find((file) => file.endsWith(`/decision-${decisionId}/decision.md`)); }
function frontmatterBlock(frontmatter, key) { const lines = frontmatter.split(/\r?\n/u), start = lines.findIndex((line) => line === `${key}:`); if (start === -1) return ""; const rows = []; for (let index = start + 1; index < lines.length && (lines[index].trim() === "" || /^\s/u.test(lines[index])); index += 1) rows.push(lines[index]); return rows.join("\n"); }
function migrationInputFiles(root) { return [path.join(root, "harness/harness.yaml"), ...walk(path.join(root, "harness/tasks")).filter((file) => /\/(?:INDEX|facts)\.md$/u.test(file)), ...walk(path.join(root, "harness/decisions")).filter((file) => /\/decision\.md$/u.test(file)), ...walk(path.join(root, "harness/events")).filter((file) => /\.json$/u.test(file))].sort(); }
function walk(directory) { const stat = statSync(directory, { throwIfNoEntry: false }); if (!stat?.isDirectory()) return []; return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : entry.isFile() ? [path.join(directory, entry.name)] : []); }

function assertWrittenSource(root) {
  const cold = readColdRebuildSource(root), targetIds = new Set(decisionRepairs.map(({ decisionId }) => decisionId));
  for (const row of cold.decisions.filter(({ decisionId }) => targetIds.has(decisionId))) if (row.rejectedRecords.some(({ id }) => !/^RJ\d+$/u.test(id))) throw new Error(`${row.decisionId} still has a non-RJ rejected option`);
  if (cold.issues.some(({ migratedFrom }) => targetIds.has(migratedFrom) || migratedFrom === relationRepair.oldId)) throw new Error("repaired source still reports a targeted cold-read issue");
  if (!cold.truth.edges.some(({ relationId, targetRef }) => relationId === relationRepair.newId && targetRef === relationRepair.newTarget)) throw new Error("replacement relation is absent from cold truth");
}

function main() {
  try {
    const { values } = parseArgs({ options: { root: { type: "string" }, write: { type: "boolean", default: false } } });
    if (!values.root) throw new Error("usage: node tools/repair-migration-import-source.mjs --root <legacy-copy> [--write]");
    process.stdout.write(`${JSON.stringify(repairMigrationImportSource(values.root, values.write), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`migration source repair failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
