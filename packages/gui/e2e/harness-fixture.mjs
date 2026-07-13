// e2e 基础设施：词表取值 / 截图 / hermetic 账本 fixture / Electron 收尾。
// 与测试本身分开——测试断言「应用做了什么」，这里只负责「把世界搭起来」。
// 拆分依据：check-file-complexity 的 600 行上限，"split by responsibility
// instead of shaving lines"。
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
export const guiRoot = resolve(repoRoot, "packages/gui");
export { repoRoot };

// The smoke test pins the renderer to zh-CN below, so it must expect zh-CN copy.
// Read it from the catalog rather than hardcoding it: the copy is not the contract,
// the key is. Copy edits must not break this test; a deleted key must.
// The catalog is sharded by namespace (components / graph / model / renderer / views),
// mirroring how i18n/core.ts merges them into one flat key→message map.
const localeDir = resolve(guiRoot, "src/renderer/i18n/locales/zh-CN");
const readLocale = (name) => JSON.parse(readFileSync(resolve(localeDir, name), "utf8"));
const smokeLocale = {
  ...readLocale("components.json"),
  ...readLocale("graph.json"),
  ...readLocale("model.json"),
  ...readLocale("renderer.json"),
  ...readLocale("views.json"),
};

export function localeLiteral(key) {
  const template = smokeLocale[key];
  assert.ok(typeof template === "string", `smoke test expects locale key ${key} to exist`);
  // Keep only the leading placeholder-free run so interpolated counts do not couple
  // the assertion to whatever the fixture ledger happens to contain.
  const literal = template.split("{")[0].trim();
  assert.ok(literal.length > 0, `locale key ${key} starts with a placeholder, cannot anchor on it`);
  return literal;
}

// Some assertions need the full interpolated string (e.g. when a {placeholder}
// value is known and stable from the fixture). Use sparingly — prefer localeLiteral
// so copy tweaks don't break the test.
export function localeText(key, params = {}) {
  const template = smokeLocale[key];
  assert.ok(typeof template === "string", `smoke test expects locale key ${key} to exist`);
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_, name) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`,
  );
}

// Build a case-insensitive regex that matches the locale literal for a key,
// tolerating arbitrary whitespace between the leading words. Used for button /
// heading selectors where the accessible name is locale copy, not an English id.
export function localeRe(key, flags = "u") {
  return new RegExp(escapeRegex(localeLiteral(key)), flags);
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// dec_01KXA7811SVVT8P66HNDFZQ7DF GUI usability evidence shots. The directory
// is a sibling of the hermetic ledger so it gets cleaned up with the test run
// but stays readable from a developer machine. Set HARNESS_GUI_E2E_SHOTS to
// a stable absolute path to retain shots across runs (used for closeout evidence).
export const screenshotDir = process.env.HARNESS_GUI_E2E_SHOTS
  ? resolve(process.env.HARNESS_GUI_E2E_SHOTS)
  : mkdtempSync(path.join(tmpdir(), "ha-gui-e2e-shots-"));

export async function captureGraphEvidence(page, name) {
  const file = path.join(screenshotDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch((error) => {
    console.warn(`[screenshot] ${name} failed: ${error.message}`);
  });
  return file;
}
export function writeTriadicLedger(rootDir) {
  const taskDir = path.join(rootDir, "harness/tasks/task-gui-smoke");
  const assocTaskDir = path.join(rootDir, "harness/tasks/task-gui-assoc");
  const decisionDir = path.join(rootDir, "harness/decisions/decision-dec_gui_smoke");
  const ancestorDecisionDir = path.join(rootDir, "harness/decisions/decision-dec_gui_ancestor");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(assocTaskDir, { recursive: true });
  mkdirSync(decisionDir, { recursive: true });
  mkdirSync(ancestorDecisionDir, { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
    "schema: harness-anything/v1",
    "name: gui-triadic-smoke",
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    ""
  ].join("\n"));
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    "task_id: task-gui-smoke",
    "title: Render the real triadic projection",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref:",
    "  titleSnapshot: Render the real triadic projection",
    "  url:",
    "  bindingCreatedAt: 2026-07-10T00:00:00.000Z",
    "  bindingFingerprint: sha256:gui-smoke",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: implementation",
    "relations:",
    "  - {relation_id: rel_bfa32bfd7f399b66, source: task/task-gui-smoke, target: fact/task-gui-smoke/F-ABCDEFGH, type: produces, strength: strong, direction: directed, origin: declared, rationale: \"Task produced the renderer projection evidence\", state: active}",
    "---",
    ""
  ].join("\n"));
  writeFileSync(path.join(taskDir, "facts.md"), [
    "- {fact_id: F-ABCDEFGH, statement: \"The GUI renderer received real triadic rows through the public bridge.\", source: \"GUI E2E\", observedAt: \"2026-07-10T00:30:00.000Z\", confidence: low, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: \"codex\", sessionId: \"fg-p1-07-e2e\", boundAt: \"2026-07-10T00:30:00.000Z\"}]}",
    ""
  ].join("\n"));
  writeFileSync(path.join(assocTaskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    "task_id: task-gui-assoc",
    "title: Render optional association context",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref:",
    "  titleSnapshot: Render optional association context",
    "  url:",
    "  bindingCreatedAt: 2026-07-10T00:10:00.000Z",
    "  bindingFingerprint: sha256:gui-assoc",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: implementation",
    "---",
    ""
  ].join("\n"));
  writeFileSync(path.join(decisionDir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    "decision_id: dec_gui_smoke",
    "_coordinatorWatermark: gui-smoke-watermark",
    "title: \"Expose the triadic projection to the GUI\"",
    "state: proposed",
    "riskTier: high",
    "urgency: high",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: [\"gui\"]",
    "  productLines: []",
    "proposedAt: \"2026-07-10T00:00:00.000Z\"",
    "provenance:",
    "  - {runtime: \"codex\", sessionId: \"fg-p1-07-e2e\", boundAt: \"2026-07-10T00:00:00.000Z\"}",
    "question: \"Should the GUI consume the public relation graph?\"",
    "chosen:",
    "  - {id: \"CH1\", text: \"Use the existing daemon/service bridge\"}",
    "  - {id: \"CH2\", text: \"Keep loose associations optional\"}",
    "rejected:",
    "  - {id: \"RJ1\", text: \"Keep the global hairball\", why_not: \"Focused graph is more legible\"}",
    "claims:",
    "  - {id: \"CH1\", text: \"The public path preserves kernel relation names\", load_bearing: true}",
    "  - {id: \"CH2\", text: \"Loose associations stay optional\", load_bearing: true}",
    "  - {id: \"RJ1\", text: \"The global hairball should remain rejected\", load_bearing: true}",
    "relations:",
    "  - {relation_id: rel_5287143733cccbd9, source: decision/dec_gui_smoke, target: task/task-gui-smoke, type: derives, strength: strong, direction: directed, origin: declared, rationale: \"Decision derived the GUI task\", state: active}",
    "  - {relation_id: rel_f0e4909f80e86478, source: decision/dec_gui_smoke/CH1, target: fact/task-gui-smoke/F-ABCDEFGH, type: evidenced-by, strength: strong, direction: directed, origin: declared, rationale: \"Fact evidences the public projection\", state: active}",
    "  - {relation_id: rel_58f5525aa9196c13, source: decision/dec_gui_smoke/CH2, target: task/task-gui-assoc, type: relates, strength: weak, direction: directed, origin: declared, rationale: \"Optional association exercises the default-off axis\", state: active}",
    "  - {relation_id: rel_6f844b22a6cc8a74, source: decision/dec_gui_smoke/CH2, target: decision/dec_gui_ancestor, type: refines, strength: strong, direction: directed, origin: declared, rationale: \"The focused graph refines the earlier projection\", state: active}",
    "---",
    ""
  ].join("\n"));
  writeFileSync(path.join(ancestorDecisionDir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    "decision_id: dec_gui_ancestor",
    "_coordinatorWatermark: gui-ancestor-watermark",
    "title: \"Earlier GUI projection decision\"",
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: [\"gui\"]",
    "  productLines: []",
    "proposedAt: \"2026-07-01T00:00:00.000Z\"",
    "decidedAt: \"2026-07-02T00:00:00.000Z\"",
    "provenance:",
    "  - {runtime: \"codex\", sessionId: \"fg-p1-07-ancestor\", boundAt: \"2026-07-01T00:00:00.000Z\"}",
    "question: \"How should the first GUI relation projection render?\"",
    "chosen:",
    "  - {id: \"CH1\", text: \"Render a single global projection\"}",
    "rejected: []",
    "claims:",
    "  - {id: \"CH1\", text: \"The first projection is globally visible\", load_bearing: true}",
    "relations: []",
    "---",
    ""
  ].join("\n"));
}

export async function closeElectronApp(electronApp) {
  const child = electronApp.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(5_000)]);
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

