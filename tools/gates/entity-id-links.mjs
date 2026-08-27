#!/usr/bin/env node
/**
 * G37 entity-id-links — GUI 实体互链不变量(清册 G-10)的静态半边。
 *
 * 不变量:页面显示的实体 ID 必须是通往该实体的可激活路径。本门在源码层识别
 * 「一个实体引用被渲染成不可激活文本」的形状,与行为半边(把每个视图渲染进
 * DOM 后扫描文本的 entity-id-links.vitest.ts,经 test:gui 必需检查执行)互补:
 *
 *   S1  静态形状:JSX 子位置的字符串/模板字面量,其值以 canonical 实体引用
 *       前缀(task/ decision/ fact/ agent/ squad/ provider/ session/)开头,
 *       且不被可激活元素包裹(button/a/带 onClick 的元素/被批准的链接原语)。
 *       这一层不追数据流 —— 数据驱动的裸 ID 由行为半边负责,这里只裁
 *       「按构造即可判定」的引用,保证零误报。
 *   S2  原语纪律:被批准的渲染原语 EntityRefLink 自身必须把 ID 文本渲染在
 *       带 onClick 的 button/a 里。原语退化为死文本时,全库的「合法出口」
 *       就变成了漏斗,所以原语本体每次都被审计。
 *   S3  接线纪律:行为半边测试文件存在且登记在 tools/gui-test-manifest.mjs。
 *       删测试或除名 = 静态半边同时变红,两半不许单独拆掉。
 *
 * 实体种类 = entityRoutes 可寻址的七类(task/decision/fact/agent/squad/
 * provider/session)。executionId、dispatchId、personId 等非路由标识符不在
 * 不变量内(没有详情页可去),由 artifacts 报告记录该语义边界。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeCiGateResult } from "../ci-gate-result.mjs";
import ts from "typescript";
import { repoRoot } from "./git.mjs";

export const ENTITY_KINDS = Object.freeze(["task", "decision", "fact", "agent", "squad", "provider", "session"]);
export const CANONICAL_REF_HEAD = new RegExp(`^(?:${ENTITY_KINDS.join("|")})/`, "u");
export const RENDERER_ROOT = "packages/gui/src/renderer";
export const LINK_PRIMITIVE_PATH = "packages/gui/src/renderer/components/EntityRefLink.tsx";
export const LINK_PRIMITIVE_NAME = "EntityRefLink";
export const BEHAVIORAL_TEST_PATH = "packages/gui/test/entity-id-links.vitest.ts";
export const BEHAVIORAL_TEST_MANIFEST = "tools/gui-test-manifest.mjs";

/** 被批准的「可激活」JSX 祖先:原生交互元素、带点击处理的元素、或链接原语。 */
const ACTIVATABLE_INTRINSICS = new Set(["button", "a"]);
const ACTIVATABLE_PROPS = new Set(["onClick", "onDoubleClick", "onActivate", "onPointerDown"]);
const SANCTIONED_COMPONENTS = new Set([LINK_PRIMITIVE_NAME]);

function walkRendererFiles(rootDir, dir = RENDERER_ROOT, out = []) {
  const absolute = path.join(rootDir, dir);
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(absolute, entry.name);
    const rel = path.relative(rootDir, child).split(path.sep).join("/");
    if (entry.isDirectory()) walkRendererFiles(rootDir, rel, out);
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) out.push(rel);
  }
  return out;
}

/** 祖先优先遍历(typescript 公共 API 只有 forEachChild;descendant 遍历自己写)。 */
export function forEachDescendant(node, visit) {
  const recurse = (current) => {
    visit(current);
    current.forEachChild(recurse);
  };
  node.forEachChild(recurse);
}

function isActivatableElement(node) {
  // 统一取 opening 形态:JsxElement 的标签/属性挂在它的 openingElement 上。
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) return false;
  const tag = opening.tagName;
  if (ts.isIdentifier(tag)) {
    if (SANCTIONED_COMPONENTS.has(tag.text)) return true;
    if (ACTIVATABLE_INTRINSICS.has(tag.text.toLowerCase())) return true;
    const props = opening.attributes?.properties ?? [];
    return props.some((prop) => ts.isJsxAttribute(prop) && ACTIVATABLE_PROPS.has(prop.name.text));
  }
  return false;
}

function hasActivatableAncestor(node) {
  let current = node.parent;
  while (current !== undefined) {
    if (isActivatableElement(current)) return true;
    current = current.parent;
  }
  return false;
}

/** 把表达式压成静态可判定的字符串;返回 null 表示数据驱动、本层不裁。 */
export function staticStringValue(expression, locals, depth = 0) {
  if (depth > 8 || expression === undefined || expression === null) return null;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const inner = staticStringValue(span.expression, locals, depth + 1);
      if (inner === null) return null;
      value += inner + span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(expression.left, locals, depth + 1);
    const right = staticStringValue(expression.right, locals, depth + 1);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isIdentifier(expression)) {
    const binding = locals.get(expression.text);
    return binding === undefined ? null : staticStringValue(binding, locals, depth + 1);
  }
  return null;
}

/**
 * 模板前缀判定:`task/${id}` 这类首段是 canonical 前缀的模板,即使尾部是
 * 动态表达式,渲染出来也必然是实体引用 —— 这是「按构造即可判定」的最大集。
 */
function staticRefHead(expression, locals, depth = 0) {
  const direct = staticStringValue(expression, locals, depth);
  if (direct !== null) return CANONICAL_REF_HEAD.test(direct) ? direct : null;
  if (ts.isTemplateExpression(expression) && CANONICAL_REF_HEAD.test(expression.head.text))
    return `${expression.head.text}…`;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(expression.left, locals, depth + 1);
    if (left !== null && CANONICAL_REF_HEAD.test(left)) {
      return `${left}…`;
    }
  }
  if (ts.isIdentifier(expression)) {
    const binding = locals.get(expression.text);
    return binding === undefined ? null : staticRefHead(binding, locals, depth + 1);
  }
  return null;
}

function collectFileLocals(sourceFile) {
  const locals = new Map();
  forEachDescendant(sourceFile, (node) => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          locals.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  });
  return locals;
}

/**
 * S1:扫描单个源码文本,返回「canonical 实体引用被渲染成不可激活文本」的违规。
 * 违规按(file, line, rendered)报告,rendered 里动态尾部以 … 截断。
 */
export function findStaticRefViolations(sourceText, fileName = "inline.tsx") {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const locals = collectFileLocals(sourceFile);
  const violations = [];
  const record = (value, node) => {
    if (value === null || hasActivatableAncestor(node)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ file: fileName, line: line + 1, rendered: value });
  };
  forEachDescendant(sourceFile, (node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile);
      if (CANONICAL_REF_HEAD.test(text.trimStart())) record(text.trimStart(), node);
      return;
    }
    const expression = ts.isJsxExpression(node) ? node.expression : undefined;
    if (expression === undefined) return;
    // 只看「子位置」的表达式(有父 JSX 且父不是属性)—— attribute 值不渲染。
    if (ts.isJsxAttribute(node.parent)) return;
    record(staticRefHead(expression, locals), expression);
  });
  return violations;
}

/**
 * S2:链接原语纪律 —— EntityRefLink 的实现必须把 entityRef 文本放进带点击
 * 处理的 button/a。原语不存在 = 门红;原语退化成死文本 = 门红。
 */
export function auditLinkPrimitive(sourceText, fileName = LINK_PRIMITIVE_PATH) {
  const problems = [];
  if (!sourceText.includes(LINK_PRIMITIVE_NAME)) {
    problems.push(`${fileName}: 链接原语 ${LINK_PRIMITIVE_NAME} 未导出`);
  }
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let interactiveWithHandler = false;
  let refTextInsideInteractive = false;
  forEachDescendant(sourceFile, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isIdentifier(node.tagName) ? node.tagName.text : "";
      const hasHandler = (node.attributes?.properties ?? []).some(
        (prop) => ts.isJsxAttribute(prop) && ACTIVATABLE_PROPS.has(prop.name.text),
      );
      if (ACTIVATABLE_INTRINSICS.has(tag.toLowerCase()) && hasHandler) {
        interactiveWithHandler = true;
        // 该交互元素的「子位置」是否渲染 entityRef(只看 children,不看属性,
        // 否则 title={entityRef} 这类提示属性会伪装成已渲染)。
        const jsxElement = ts.isJsxElement(node.parent) ? node.parent : null;
        for (const child of jsxElement?.children ?? []) {
          forEachDescendant(child, (descendant) => {
            if (ts.isIdentifier(descendant) && descendant.text === "entityRef") refTextInsideInteractive = true;
          });
        }
      }
    }
  });
  if (!interactiveWithHandler) problems.push(`${fileName}: 链接原语必须渲染一个带点击处理的 button/a`);
  else if (!refTextInsideInteractive) problems.push(`${fileName}: entityRef 文本必须落在带点击处理的交互元素内部`);
  return problems;
}

/** S3:行为半边必须存在且登记 —— 两半不许被单独拆掉。 */
export function auditBehavioralWiring(rootDir) {
  const problems = [];
  if (!existsSync(path.join(rootDir, BEHAVIORAL_TEST_PATH))) {
    problems.push(`${BEHAVIORAL_TEST_PATH}: 行为半边测试不存在(DOM 扫描是本不变量的主判据)`);
  }
  const manifestPath = path.join(rootDir, BEHAVIORAL_TEST_MANIFEST);
  if (!existsSync(manifestPath)) {
    problems.push(`${BEHAVIORAL_TEST_MANIFEST}: 测试登记清单不存在(test:gui 无法执行任何行为半边)`);
  } else if (!readFileSync(manifestPath, "utf8").includes(BEHAVIORAL_TEST_PATH)) {
    problems.push(`${BEHAVIORAL_TEST_MANIFEST}: 未登记 ${BEHAVIORAL_TEST_PATH}(test:gui 不会执行它)`);
  }
  return problems;
}

export function scanRendererTree(rootDir) {
  const violations = [];
  for (const file of walkRendererFiles(rootDir)) {
    const text = readFileSync(path.join(rootDir, file), "utf8");
    violations.push(...findStaticRefViolations(text, file));
  }
  const problems = [];
  const primitivePath = path.join(rootDir, LINK_PRIMITIVE_PATH);
  if (!existsSync(primitivePath)) {
    problems.push(`${LINK_PRIMITIVE_PATH}: 被批准的实体链接原语不存在 —— 不变量没有统一的合法出口`);
  } else {
    problems.push(...auditLinkPrimitive(readFileSync(primitivePath, "utf8")));
  }
  problems.push(...auditBehavioralWiring(rootDir));
  return { violations, problems };
}

function explain({ violations, problems }) {
  const lines = ["=".repeat(78), "G37 entity-id-links FAILED — 实体 ID 互链不变量被违反", "=".repeat(78), ""];
  if (violations.length > 0) {
    lines.push("S1 · 静态裸引用(canonical 实体引用渲染成了不可激活文本):");
    for (const v of violations) lines.push(`  ${v.file}:${v.line}  ${v.rendered}`);
  }
  if (problems.length > 0) {
    lines.push("机制问题(原语/接线被破坏):");
    for (const p of problems) lines.push(`  ${p}`);
  }
  lines.push(
    "",
    "不变量(清册 G-10):页面显示的实体 ID 必须是通往该实体的可激活路径。",
    "修复方式:用 components/EntityRefLink.tsx 渲染该 ID,并把 onNavigate 接到",
    "视图层回调(navigateToEntity / selectRuntimeEntity / navigateToTask)。",
    "不要为了过门把 ID 从页面上藏起来 —— 那是把要求反着实现。",
    "",
    "另一半天在 packages/gui/test/entity-id-links.vitest.ts(渲染 DOM 后扫描,",
    "经 test:gui 必需检查执行);两层判据互补,单独拆掉任何一层都会让本门变红。",
  );
  return lines.join("\n");
}

function main() {
  const rootDir = repoRoot();
  const result = scanRendererTree(rootDir);
  const pass = result.violations.length === 0 && result.problems.length === 0;
  writeCiGateResult("G37", pass, { violations: result.violations.length, wiringProblems: result.problems.length });
  if (!pass) {
    console.error(explain(result));
    return 1;
  }
  console.log("G37 entity-id-links: pass");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
