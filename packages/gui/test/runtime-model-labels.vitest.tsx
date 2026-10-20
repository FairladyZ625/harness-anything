// harness-test-tier: contract
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentEntityRow } from "../src/renderer/agent-entity-client.ts";
import { AgentCard } from "../src/renderer/components/runtime/AgentCard.tsx";
import { IdentityRail } from "../src/renderer/components/runtime/RuntimeRail.tsx";
import { DeleteEntityDialog, RetireAgentDialog } from "../src/renderer/components/runtime/EntityLifecycleDialog.tsx";
import { saveFailureHint } from "../src/renderer/components/runtime/useRuntimeWorkspace.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  runtimeModelCandidates,
  runtimeModelFullLabel,
  runtimeModelShortLabel,
} from "../src/renderer/model/runtime-models.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

describe("runtime model candidate parsing", () => {
  // deepseek-harness 的约定:候选模型清单以 JSON 数组文本原样写进 model 字符串。
  const candidates = '["deepseek-account","deepseek-flash"]';
  it("parses JSON-array model text into its candidate list", () => {
    expect(runtimeModelCandidates(candidates)).toEqual(["deepseek-account", "deepseek-flash"]);
    expect(runtimeModelCandidates("glm-5.3")).toBeNull();
    expect(runtimeModelCandidates(undefined)).toBeNull();
    expect(runtimeModelCandidates("[]")).toBeNull();
    expect(runtimeModelCandidates('["a", 3]')).toBeNull();
    expect(runtimeModelCandidates("[not json")).toBeNull();
  });
  it("labels the rail short form as first candidate plus overflow, full form as every candidate", () => {
    expect(runtimeModelShortLabel(candidates)).toBe("deepseek-account +1");
    expect(runtimeModelShortLabel('["only-one"]')).toBe("only-one");
    expect(runtimeModelShortLabel("glm-5.3")).toBe("glm-5.3");
    expect(runtimeModelFullLabel(candidates)).toBe("deepseek-account / deepseek-flash");
    expect(runtimeModelFullLabel("glm-5.3")).toBe("glm-5.3");
  });
});

const mounted: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});
async function mount(element: React.ReactElement) {
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push(root);
  await act(async () => {
    root.render(element);
  });
  return container;
}
const byTestId = (testId: string): HTMLElement => {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  expect(element, `missing data-testid=${testId}`).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
};

const agentRow = (
  id: string,
  overrides: Partial<Extract<AgentEntityRow, { readonly name: string }>> = {},
): AgentEntityRow => ({
  id,
  name: overrides.name ?? id,
  runtimes: [],
  instance: null,
  permissionMode: null,
  role: "worker",
  layer: "user",
  retirement: null,
  ...overrides,
});

describe("identity rail rows for candidate-list models and retired agents", () => {
  it("shows the short candidate label on the row and the full list in the hover text", async () => {
    const deepseek = agentRow("deepseek-reviewer", {
      name: "DeepSeek Harness · Reviewer",
      runtimes: [{ type: "deepseek-harness", model: '["deepseek-account","deepseek-flash"]' }],
    });
    await mount(
      createElement(IdentityRail, {
        agents: [deepseek],
        squads: [],
        selection: null,
        onSelect: () => undefined,
        onNew: () => undefined,
        agentNames: new Map(),
        squadsByAgent: new Map(),
      }),
    );
    const row = byTestId("rail-agent-deepseek-reviewer");
    expect(row.textContent).toContain("deepseek-account +1");
    // 名字列完整在场——长 JSON 串不再挤占行面。
    expect(row.textContent).toContain("DeepSeek Harness · Reviewer");
    expect(row.textContent).not.toContain('["deepseek-account","deepseek-flash"]');
    expect(row.querySelector<HTMLElement>("[data-dense-row]")?.getAttribute("title")).toContain(
      "deepseek-account / deepseek-flash",
    );
  });

  it("renders a retired row with the tag, the successor, and the reason in the hover text", async () => {
    const retired = agentRow("luna", {
      name: "Luna",
      runtimes: [{ type: "codex" }],
      retirement: {
        retiredAt: "2026-09-30T08:00:00.000Z",
        reason: "superseded by terra",
        successor: "terra",
      },
    });
    await mount(
      createElement(IdentityRail, {
        agents: [retired],
        squads: [],
        selection: null,
        onSelect: () => undefined,
        onNew: () => undefined,
        agentNames: new Map(),
        squadsByAgent: new Map(),
      }),
    );
    const row = byTestId("rail-agent-luna");
    expect(row.textContent).toContain("Retired");
    expect(row.textContent).toContain("→ terra");
    expect(row.querySelector<HTMLElement>("[data-dense-row]")?.getAttribute("title")).toContain("superseded by terra");
  });
});

describe("retire and delete dialogs", () => {
  it("keeps the retire confirm disabled until a reason is entered, then emits reason and successor", async () => {
    const onRetire = vi.fn();
    await mount(
      createElement(RetireAgentDialog, {
        open: true,
        agent: { id: "luna", name: "Luna" },
        agents: [agentRow("terra", { name: "Terra" }), agentRow("luna", { name: "Luna" })],
        busy: false,
        onCancel: () => undefined,
        onRetire,
      }),
    );
    const confirm = byTestId("retire-agent-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const reason = byTestId("retire-agent-reason") as HTMLTextAreaElement;
    const setTextArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setTextArea?.call(reason, "superseded");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirm.disabled).toBe(false);
    const successor = byTestId("retire-agent-successor") as HTMLSelectElement;
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setSelect?.call(successor, "terra");
      successor.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      confirm.click();
    });
    expect(onRetire).toHaveBeenCalledWith({ reason: "superseded", successor: "terra" });
  });

  it("keeps the delete confirm disabled until a reason is entered, then emits it", async () => {
    const onDelete = vi.fn();
    await mount(
      createElement(DeleteEntityDialog, {
        open: true,
        kind: "squad",
        entity: { id: "core-squad", name: "Core Squad" },
        busy: false,
        onCancel: () => undefined,
        onDelete,
      }),
    );
    const confirm = byTestId("delete-squad-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const reason = byTestId("delete-squad-reason") as HTMLTextAreaElement;
    const setArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setArea?.call(reason, "obsolete");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      confirm.click();
    });
    expect(onDelete).toHaveBeenCalledWith({ reason: "obsolete" });
  });
});

describe("entity write rejection mapping", () => {
  it("maps the daemon agent_referenced rejection to the retire-only hint", () => {
    const mapped = saveFailureHint({
      outcome: "op_rejected",
      error: { code: "agent_referenced", hint: "Agent terra is still referenced (squad: 1)." },
    });
    expect(mapped).toContain("can only be retired");
    expect(mapped).toContain("squad: 1");
  });
  it("keeps other rejection hints as-is", () => {
    expect(saveFailureHint({ outcome: "op_rejected", error: { code: "revision_conflict", hint: "stale" } })).toBe(
      "stale",
    );
  });
});

describe("agent card lifecycle entries", () => {
  const detail = {
    id: "terra",
    name: "Terra",
    runtimes: [{ type: "codex" }],
    role: "worker",
    instructions: "Work.",
    skills: [],
    prompts: [],
    preset: null,
    revision: 3,
    retirement: null,
  } as const;
  const base = {
    row: null,
    squads: [],
    instances: [],
    busy: false,
    onSave: () => undefined,
    onDispatch: () => undefined,
    onSelectRuntime: () => undefined,
    onSelectAgent: () => undefined,
  };
  it("disables delete with the retire-only hint while a local reference surface exists", async () => {
    await mount(
      createElement(AgentCard, {
        ...base,
        detail,
        onRetire: () => undefined,
        onDelete: () => undefined,
        deleteBlockedBy: ["Core Squad", "roles.defaultWorker"],
      }),
    );
    const del = byTestId("agent-delete-entry") as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(document.body.textContent).toContain("Referenced");
    expect(byTestId("agent-retire-entry")).toBeInstanceOf(HTMLButtonElement);
  });
  it("hides the retire entry and dispatch once the identity is retired", async () => {
    await mount(
      createElement(AgentCard, {
        ...base,
        detail: { ...detail, retirement: { retiredAt: "2026-09-30T08:00:00.000Z", reason: "done" } },
        onDelete: () => undefined,
      }),
    );
    expect(document.querySelector('[data-testid="agent-retire-entry"]')).toBeNull();
    expect(byTestId("agent-retirement-line").textContent).toContain("done");
    expect((byTestId("dispatch-entry-terra") as HTMLButtonElement).disabled).toBe(true);
  });
});
