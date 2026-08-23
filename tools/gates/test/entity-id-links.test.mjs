// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditBehavioralWiring,
  auditLinkPrimitive,
  findStaticRefViolations,
  BEHAVIORAL_TEST_PATH,
  BEHAVIORAL_TEST_MANIFEST
} from "../entity-id-links.mjs";

/**
 * G37 entity-id-links 契约测试。阳性对照是本文件的一等公民:每个判据都带
 * 「故意违反必须被抓到」的用例 —— 一个永远 pass 的门和一个被抓不到的门
 * 在这里无法区分。
 */

const GOOD_PRIMITIVE = `
import type { ReactNode } from "react";
export function EntityRefLink({ entityRef, onNavigate, children, title, className }: {
  entityRef: string; onNavigate: (ref: string) => void; children?: ReactNode; title?: string; className?: string;
}) {
  return (
    <button type="button" onClick={() => onNavigate(entityRef)} title={title ?? entityRef}
      className={className ?? "font-mono text-[11px] text-accent hover:underline"}>
      {children ?? entityRef}
    </button>
  );
}
`;

test("S1 阳性对照:字面量 canonical 引用渲染成不可激活文本被抓到", () => {
  const violations = findStaticRefViolations(
    `export function Dead({ ref }: { ref: string }) {
  return <div><span>{"task_51502b11d6822ae3cd193cf9bb".replace("X", "x") ? "task/51502b11" : ""}</span><p>see {"decision/dec_control"}</p></div>;
}`,
    "control.tsx"
  );
  assert.ok(
    violations.some((v) => v.rendered === "decision/dec_control"),
    `expected the dead decision ref to be flagged, got ${JSON.stringify(violations)}`
  );
});

test("S1 阳性对照:模板组合引用(动态尾部)按前缀判形,不靠字段名", () => {
  const violations = findStaticRefViolations(
    "export function T({ whatever, tail }: { whatever: string; tail: string }) {\n  return <p>{`provider/${whatever}/${tail}`}</p>;\n}",
    "control.tsx"
  );
  assert.deepEqual(violations, [{ file: "control.tsx", line: 2, rendered: "provider/…" }]);
});

test("S1 阳性对照:局部常量绑定到引用字面量后仍按形状判定", () => {
  const violations = findStaticRefViolations(
    'const peerRef = "squad/core-squad";\nexport function C() { return <span>{peerRef}</span>; }',
    "control.tsx"
  );
  assert.deepEqual(violations, [{ file: "control.tsx", line: 2, rendered: "squad/core-squad" }]);
});

test("S1 阴性对照:可激活祖先(button/a/onClick)与七类之外的标识符放行", () => {
  const clean = findStaticRefViolations(
    `export function Ok({ execId, presetId }: { execId: string; presetId: string }) {
  const sessionRef = "session/g37-live";
  return (
    <div>
      <button onClick={() => undefined}>{sessionRef}</button>
      <a href="#detail">{"agent/terra"}</a>
      <span onClick={() => undefined}>{"fact/task_t/F-1"}</span>
      <span title={"task/hidden-in-tooltip"}>label</span>
      <p>execution {execId} · preset {presetId}</p>
      <span>the task/list mention is prose, not a ref node</span>
    </div>
  );
}`,
    "ok.tsx"
  );
  assert.deepEqual(clean, []);
});

test("S2 阳性对照:链接原语退化为死文本时被拒绝", () => {
  const dead = `export function EntityRefLink({ entityRef }: { entityRef: string }) {\n  return <span>{entityRef}</span>;\n}\n`;
  assert.match(auditLinkPrimitive(dead).join("\n"), /带点击处理的 button\/a/u);
});

test("S2 阳性对照:ID 只出现在 title 属性、不落在子位置时被拒绝", () => {
  const attrOnly = `export function EntityRefLink({ entityRef, onNavigate }: { entityRef: string; onNavigate: (r: string) => void }) {\n  return <button type="button" onClick={() => onNavigate(entityRef)} title={entityRef}>open</button>;\n}\n`;
  assert.match(auditLinkPrimitive(attrOnly).join("\n"), /entityRef 文本必须落在/u);
});

test("S2 阴性对照:ID 文本在带点击处理的交互元素内部时放行", () => {
  assert.deepEqual(auditLinkPrimitive(GOOD_PRIMITIVE), []);
});

test("S3 阳性对照:行为半边缺失或未登记时被拒绝", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "g37-wiring-"));
  mkdirSync(path.join(rootDir, path.dirname(BEHAVIORAL_TEST_PATH)), { recursive: true });
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  const noTest = auditBehavioralWiring(rootDir);
  assert.equal(noTest.length, 2);

  writeFileSync(path.join(rootDir, BEHAVIORAL_TEST_PATH), "// vitest\n");
  writeFileSync(path.join(rootDir, BEHAVIORAL_TEST_MANIFEST), 'export const guiVitestManifest = ["packages/gui/test/other.vitest.ts"];\n');
  const unregistered = auditBehavioralWiring(rootDir);
  assert.equal(unregistered.length, 1);
  assert.match(unregistered[0], new RegExp(BEHAVIORAL_TEST_PATH.replaceAll("/", "\\/")));

  writeFileSync(path.join(rootDir, BEHAVIORAL_TEST_MANIFEST), `export const guiVitestManifest = ["${BEHAVIORAL_TEST_PATH}"];\n`);
  assert.deepEqual(auditBehavioralWiring(rootDir), []);
});

