// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import {
  VerticalKindForm,
  describeRelationsIssue,
  locateJsonError,
} from "../src/renderer/components/entityDoc/VerticalKindForm.tsx";
import type { ArtifactKindDeclaration } from "../src/renderer/vertical-kind-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * kind 声明表单的收敛判据(task_a494eac2 Goal 3):编辑时身份/存储字段只读展示
 * (没有任何输入框),可编辑的只有 display / maturityVocabulary / relations;新建时
 * 按模板预填并逐字段说明;relations 的 JSON 错误能定位到行列或下标。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];

const INITIAL: ArtifactKindDeclaration = {
  id: "architecture-decision-record",
  entityType: "artifact",
  version: 2,
  idPrefix: "ADR",
  display: { singular: "Architecture Decision Record", plural: "Architecture Decision Records" },
  descriptorSchemaRef: "schema://artifact-descriptor",
  store: { pathTemplate: "entities/adrs/{id}.json" },
  locatorKinds: ["repository-path"],
  maturityVocabulary: ["draft", "accepted"],
};

beforeAll(() => {
  setActiveLocale("zh-CN");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { root } of mounted.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function renderForm(initial?: ArtifactKindDeclaration): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(VerticalKindForm, {
        ...(initial === undefined ? {} : { initial }),
        busy: false,
        error: null,
        onCancel: () => undefined,
        onSubmit: () => undefined,
      }),
    );
  });
  mounted.push({ root, container });
  return container;
}

async function typeInto(container: HTMLElement, label: string, text: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input, label).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input!, text);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function typeTextarea(container: HTMLElement, label: string, text: string): Promise<void> {
  const area = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  expect(area, label).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area!, text);
    area!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("edit mode: identity fields are read-only display", () => {
  it("renders identity/storage as a definition list with no inputs for them", async () => {
    const container = await renderForm(INITIAL);
    const identity = container.querySelector('[data-testid="vertical-kind-identity"]');
    expect(identity?.textContent).toContain("architecture-decision-record");
    expect(identity?.textContent).toContain("entities/adrs/{id}.json");
    for (const label of ["id", "version", "idPrefix", "descriptorSchemaRef", "store.pathTemplate"]) {
      expect(container.querySelector(`input[aria-label="${label}"]`), label).toBeNull();
      expect(container.querySelector(`input[aria-label="${label}"][disabled]`), label).toBeNull();
    }
    // 可编辑的仍在:display 与词表。
    expect(container.querySelector('input[aria-label="display.singular"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="maturityVocabulary(逗号分隔)"]')).not.toBeNull();
  });
});

describe("new mode: template, not a blank form", () => {
  it("prefills template defaults and keeps identity editable with hints", async () => {
    const container = await renderForm();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="descriptorSchemaRef"]')?.value).toBe(
      "schema://artifact-descriptor",
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="store.pathTemplate"]')?.value).toBe(
      "entities/{id}.json",
    );
    const locatorCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(locatorCheckbox?.checked).toBe(true);
    // 字段说明在场:不是空白表单让人盲填。
    expect(container.textContent).toContain("创建后不可改");
    expect(container.textContent).toContain("描述符落盘路径模板");
  });
});

describe("relations JSON editor localizes errors", () => {
  it("locates a parse error to line and column", () => {
    const message = locateJsonError("Unexpected token '}', ...\"}\" is not valid JSON (line 2 column 5)", "[\n}]");
    expect(message).toContain("第 2 行第 5 列");
  });

  it("converts a byte position into line and column", () => {
    const message = locateJsonError("Unexpected end of JSON input at position 7", "[\n  {}");
    expect(message).toContain("第 2 行");
  });

  it("reports the item index for structural violations", () => {
    const relation = {
      type: "relates",
      sourceKind: "task",
      targetKind: "software/coding/x@1",
      reads: "读取理由",
      strength: "weak",
      decisionClaimRef: "decision/dec_X/C1",
      decisionContentPin: `sha256:${"0".repeat(64)}`,
    };
    expect(describeRelationsIssue(JSON.stringify([relation]))).toBeNull();
    expect(describeRelationsIssue("not json")).toContain("JSON 解析失败");
    expect(describeRelationsIssue('{"a":1}')).toBe("relations 必须是 JSON 数组。");
    expect(describeRelationsIssue(JSON.stringify([{ ...relation, strength: "medium" }]))).toContain(
      "relations[0]:strength 只能是 weak 或 strong",
    );
    const { decisionClaimRef: _omitted, ...missingClaim } = relation;
    expect(describeRelationsIssue(JSON.stringify([relation, missingClaim]))).toContain(
      "relations[1]:缺少字段 decisionClaimRef",
    );
    expect(describeRelationsIssue(JSON.stringify([{ ...relation, extra: 1 }]))).toContain(
      "relations[0]:未声明字段 extra",
    );
  });

  it("shows the issue inline while typing", async () => {
    const container = await renderForm();
    // 展开可折叠编辑器。
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="vertical-kind-relations"] > button');
    await act(async () => {
      toggle!.click();
    });
    await typeTextarea(container, "relations JSON", "[\n}");
    expect(container.querySelector('[data-testid="vertical-kind-relations-issue"]')?.textContent).toContain(
      "JSON 解析失败",
    );
  });
});

describe("submission", () => {
  it("keeps the submit disabled until required editable fields are valid", async () => {
    const container = await renderForm();
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.disabled).toBe(true);
    await typeInto(container, "display.singular", "Research Note");
    await typeInto(container, "display.plural", "Research Notes");
    await typeInto(container, "idPrefix", "RSRCH");
    await typeInto(container, "id", "research-note");
    expect(submit?.disabled).toBe(false);
    await typeInto(container, "idPrefix", "1BAD");
    expect(submit?.disabled).toBe(true);
    await typeInto(container, "idPrefix", "RSRCH");
    expect(submit?.disabled).toBe(false);
  });
});
