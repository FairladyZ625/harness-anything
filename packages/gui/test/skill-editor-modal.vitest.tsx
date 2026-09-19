// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { AgentCard } from "../src/renderer/components/runtime/AgentCard.tsx";
import { SkillEditorModal, resolveSkillManifestPath } from "../src/renderer/components/runtime/SkillEditorModal.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * Skill 查看与编辑解耦(task_5dfe382f)的交互证据:点击技能药丸正文只打开详情浮层,
 * 不删技能;只有药丸上的 × 热区触发移除、且绝不打开浮层;浮层内预览/编辑切换、
 * 保存按钮与 Cmd+S 都走 localDoc 写通道。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const noop = () => undefined;
const SKILL_DIR = "/Users/test/.claude/skills/review";
const SKILL_MD = `${SKILL_DIR}/SKILL.md`;
const agentDetail = {
  id: "fable",
  name: "fable",
  runtimes: [{ type: "claude" }],
  role: "worker",
  instructions: "Do the work.",

  skills: [{ id: "review", path: SKILL_DIR }],
  prompts: [],
  preset: null,
} as const;
const availableSkills = [
  { id: "review", path: SKILL_DIR, source: "user" },
  { id: "triage", path: "/repo/skills/triage", source: "project" },
] as const;

function stubLocalDocBridge(handlers: {
  readonly read?: (input: { readonly path: string }) => Promise<unknown>;
  readonly write?: (input: { readonly path: string; readonly content: string }) => Promise<unknown>;
}): void {
  vi.stubGlobal("window", Object.assign(window, { harness: { localDoc: handlers } }));
}

const mounted: { root: Root; container: HTMLElement }[] = [];

async function renderAgentCard(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(AgentCard, {
        detail: agentDetail,
        row: null,
        squads: [],
        instances: [],
        availableSkills,
        presets: [],
        busy: false,
        onSave: noop,
        onDispatch: noop,
        onSelectSquad: noop,
        onSelectRuntime: noop,
        onSelectAgent: noop,
      }),
    );
  });
  mounted.push({ root, container });
  return container;
}

async function renderSkillEditorModal(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(SkillEditorModal, {
        skill: { id: "review", path: SKILL_DIR },
        availableSkills,
        onClose: noop,
      }),
    );
  });
  mounted.push({ root, container });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function unmountAll(): Promise<void> {
  await act(async () => {
    for (const { root } of mounted.splice(0)) root.unmount();
  });
}

function buttonByText(root: Element, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  expect(button, `button "${text}" must exist`).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("skill chip click/remove decoupling on the agent card", () => {
  it("clicking the chip body opens the editor modal and keeps the skill attached", async () => {
    const read = vi.fn(async () => ({ ok: true, path: SKILL_MD, content: "# review skill\n", sizeBytes: 15 }));
    stubLocalDocBridge({ read });
    const container = await renderAgentCard();
    const chipBody = container.querySelector(`[data-tip="${SKILL_DIR}"] button`)!;
    expect(chipBody).not.toBeNull();
    await act(async () => {
      chipBody.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="skill-editor-modal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="doc-reader"]')).not.toBeNull();
    expect(read).toHaveBeenCalledWith({ path: SKILL_MD });
    // 药丸仍在(技能没有被删):未回退到空态,Chip 数量不变。
    expect(container.textContent).not.toContain("未选择 skill");
    expect(container.querySelectorAll(`[data-tip="${SKILL_DIR}"]`).length).toBe(1);
    await unmountAll();
  });

  it("clicking the chip × removes the skill and never opens the modal", async () => {
    const read = vi.fn();
    stubLocalDocBridge({ read });
    const container = await renderAgentCard();
    const remove = container.querySelector(`[data-tip="${SKILL_DIR}"] button[aria-label="移除该 Skill"]`)!;
    expect(remove).not.toBeNull();
    await act(async () => {
      remove.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="skill-editor-modal"]')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(container.textContent).toContain("未选择 skill");
    await unmountAll();
  });

  it("inspects a not-yet-added skill from the search list without adding it", async () => {
    stubLocalDocBridge({
      read: async () => ({ ok: true, path: "/repo/skills/triage/SKILL.md", content: "body", sizeBytes: 4 }),
    });
    const container = await renderAgentCard();
    await act(async () => {
      setNativeValue(container.querySelector<HTMLInputElement>('[data-testid="agent-skill-search"]')!, "triage");
    });
    const inspect = container.querySelector<HTMLButtonElement>('[data-testid="agent-skill-inspect"]')!;
    expect(inspect).not.toBeNull();
    await act(async () => {
      inspect.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="skill-editor-modal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="skill-editor-path"]')!.textContent).toContain(
      "/repo/skills/triage/SKILL.md",
    );
    // 只看不加:triage 仍未进入已选列表。
    expect(container.querySelectorAll(`[data-tip="${SKILL_DIR}"]`).length).toBe(1);
    await unmountAll();
  });
});

describe("SkillEditorModal preview, edit and save", () => {
  it("resolves the SKILL.md manifest path from declarations and the catalog", () => {
    expect(resolveSkillManifestPath({ id: "review", path: SKILL_DIR })).toBe(SKILL_MD);
    expect(resolveSkillManifestPath({ id: "x", path: "/repo/skills/x/SKILL.md" })).toBe("/repo/skills/x/SKILL.md");
    expect(resolveSkillManifestPath({ id: "triage", path: "skills/triage" }, availableSkills)).toBe(
      "/repo/skills/triage/SKILL.md",
    );
    expect(resolveSkillManifestPath({ id: "review", path: "~/skills/review" })).toBe("~/skills/review/SKILL.md");
    expect(resolveSkillManifestPath({ id: "missing", path: "skills/missing" }, availableSkills)).toBe(
      "skills/missing/SKILL.md",
    );
  });

  it("switches between the DocReader preview and the source editor, then saves via the button", async () => {
    const write = vi.fn(async () => ({ ok: true, path: SKILL_MD, sizeBytes: 13 }));
    stubLocalDocBridge({
      read: async () => ({ ok: true, path: SKILL_MD, content: "# original\n", sizeBytes: 11 }),
      write,
    });
    const container = await renderSkillEditorModal();
    await flush();
    expect(container.querySelector('[data-testid="doc-reader"]')).not.toBeNull();
    await act(async () => {
      buttonByText(container, "编辑").click();
    });
    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="skill-editor-source"]')!;
    expect(editor.value).toBe("# original\n");
    await act(async () => {
      setNativeValue(editor, "# edited body\n");
    });
    expect(container.querySelector('[data-testid="skill-editor-unsaved"]')).not.toBeNull();
    await act(async () => {
      buttonByText(container, "保存").click();
    });
    expect(write).toHaveBeenCalledWith({ path: SKILL_MD, content: "# edited body\n" });
    expect(container.querySelector('[data-testid="skill-editor-saved"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="skill-editor-unsaved"]')).toBeNull();
    await unmountAll();
  });

  it("saves from the Cmd+S shortcut and surfaces a typed failure instead of throwing", async () => {
    const write = vi.fn(async () => ({ ok: false, code: "not_writable", path: SKILL_MD, message: "EACCES" }));
    stubLocalDocBridge({
      read: async () => ({ ok: true, path: SKILL_MD, content: "# original\n", sizeBytes: 11 }),
      write,
    });
    const container = await renderSkillEditorModal();
    await flush();
    await act(async () => {
      buttonByText(container, "编辑").click();
    });
    await act(async () => {
      setNativeValue(
        container.querySelector<HTMLTextAreaElement>('[data-testid="skill-editor-source"]')!,
        "# via shortcut\n",
      );
    });
    const event = new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(write).toHaveBeenCalledWith({ path: SKILL_MD, content: "# via shortcut\n" });
    await flush();
    expect(container.querySelector('[data-testid="local-doc-error-not_writable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="skill-editor-unsaved"]')).not.toBeNull();
    await unmountAll();
  });
});
