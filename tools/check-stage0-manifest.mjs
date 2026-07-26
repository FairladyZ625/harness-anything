#!/usr/bin/env node
// 宪章机械核验器。
// 校验 docs-release/constitution/stage0.md 的 machine 块与 kernel 域源码逐项一致 + 内容钉一致。
// 用法: node tools/check-stage0-manifest.mjs [--write-pin]   漂移或钉不符 => 退出码 1

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const manifestPath = resolve(repoRoot, "docs-release/constitution/stage0.md");
const pinPath = resolve(repoRoot, "docs-release/constitution/stage0.pin");

const manifest = readFileSync(manifestPath, "utf8");
const failures = [];
const oks = [];

// ---- 抽取 manifest machine 块 ----
const yamlMatch = manifest.match(/```yaml\n([\s\S]*?)```/);
if (!yamlMatch) { console.error("FAIL: manifest 缺 machine 块"); process.exit(1); }
const yaml = yamlMatch[1];

function yamlList(section, key) {
  const scope = section ? (yaml.split(new RegExp(`\\b${section}:`))[1] ?? "") : yaml;
  const m = scope.match(new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`));
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

// ---- 抽取源码枚举 ----
function sourceList(relPath, constName) {
  const src = readFileSync(resolve(repoRoot, relPath), "utf8");
  const m = src.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\]`));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function compare(label, fromManifest, fromSource) {
  if (!fromManifest) { failures.push(`${label}: manifest 缺项`); return; }
  if (!fromSource) { failures.push(`${label}: 源码抽取失败(常量名或文件变了)`); return; }
  const a = new Set(fromManifest); const b = new Set(fromSource);
  const missing = [...b].filter((x) => !a.has(x));
  const extra = [...a].filter((x) => !b.has(x));
  if (missing.length || extra.length) {
    failures.push(`${label}: 漂移 manifest缺[${missing}] manifest多[${extra}]`);
  } else {
    oks.push(`${label}: 一致 (${b.size} 项)`);
  }
}

compare("relationTypes",
  yamlList(null, "relationTypes"),
  sourceList("packages/kernel/src/domain/entity-relation.ts", "relationTypes"));
compare("relationDirections",
  yamlList(null, "relationDirections"),
  sourceList("packages/kernel/src/domain/entity-relation.ts", "relationDirections"));
compare("taskStatuses.open",
  yamlList("taskStatuses", "open"),
  sourceList("packages/kernel/src/domain/lifecycle-status.ts", "openDomainStatuses"));
compare("taskStatuses.terminal",
  yamlList("taskStatuses", "terminal"),
  sourceList("packages/kernel/src/domain/lifecycle-status.ts", "terminalDomainStatuses"));
compare("decisionStates.all",
  yamlList("decisionStates", "all"),
  sourceList("packages/kernel/src/domain/decision-lifecycle-status.ts", "decisionStates"));
compare("decisionStates.terminal",
  yamlList("decisionStates", "terminal"),
  sourceList("packages/kernel/src/domain/decision-lifecycle-status.ts", "terminalDecisionStates"));

// ---- 内容钉 ----
const digest = createHash("sha256").update(manifest).digest("hex");
if (process.argv.includes("--write-pin")) {
  writeFileSync(pinPath, digest + "\n");
  oks.push(`pin: 已写入 ${digest.slice(0, 16)}…`);
} else if (!existsSync(pinPath)) {
  failures.push("pin: 缺 docs-release/constitution/stage0.pin(先跑 --write-pin)");
} else {
  const pinned = readFileSync(pinPath, "utf8").trim();
  if (pinned === digest) oks.push(`pin: 一致 ${digest.slice(0, 16)}…`);
  else failures.push(`pin: 不符(宪章被改而未走修宪协议) pinned=${pinned.slice(0, 16)}… actual=${digest.slice(0, 16)}…`);
}

for (const line of oks) console.log("OK  " + line);
for (const line of failures) console.error("FAIL " + line);
console.log(failures.length ? `\nstage0-manifest: RED (${failures.length} 项漂移)` : "\nstage0-manifest: GREEN");
process.exit(failures.length ? 1 : 0);
