// harness-test-tier: contract
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentVersionPanel } from "../src/renderer/components/runtime/AgentVersionPanel.tsx";
import { agentEntityClient, type AgentVersionRead } from "../src/renderer/agent-entity-client.ts";
import { saveFailureHint, useAgentSquadWorkspace } from "../src/renderer/components/runtime/useRuntimeWorkspace.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { t } from "../src/renderer/i18n/core.ts";

/**
 * 版本面与写栅栏(design §3.4 / §6.2 R2)。两件事:
 *  1. 面板列出 daemon 的声明版本,回退按钮把选中版本的正文按详情 revision 递回 onSave ——
 *     与保存声明同一条 agent-install 写路,不新增写动作。
 *  2. GUI 保存把读到的 revision 递给 daemon;并发保存的后者得到 revision_conflict,
 *     错误提示要求重载而不是报告成功。
 */

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});
afterEach(() => {
  vi.restoreAllMocks();
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

const mounted: { root: Root; container: HTMLElement }[] = [],
  sha = (fill: string) => fill.repeat(64);

function mount(
  element: React.ReactElement,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  mounted.push({ root, container });
  return container;
}
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** Let React Query settle: the panel reads history on mount and one version per selection. */
async function flushQueries() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function historyFixture(live: number) {
  return {
    schema: "agent-history/v1" as const,
    ok: true as const,
    agentId: "terra",
    revision: live,
    versions: [
      {
        revision: 3,
        opId: "op-3",
        sha256: sha("c"),
        size: 300,
        occurredAt: "2026-10-26T00:00:03.000Z",
        actor: { personId: "person-a", executorId: null },
        current: true,
        summary: "instructions 300 B · 0 skills · 1 runtime",
      },
      {
        revision: 2,
        opId: "op-2",
        sha256: sha("b"),
        size: 200,
        occurredAt: "2026-10-26T00:00:02.000Z",
        actor: { personId: "person-a", executorId: null },
        current: false,
        summary: "instructions 200 B · 0 skills · 1 runtime",
      },
      {
        revision: 1,
        opId: "op-1",
        sha256: sha("a"),
        size: 100,
        occurredAt: "2026-10-26T00:00:01.000Z",
        actor: { personId: "person-b", executorId: null },
        current: false,
        summary: null,
      },
    ],
    hasMore: false,
    nextCursor: null,
  };
}

const versionFixture = (revision: number, live: number): AgentVersionRead => ({
  schema: "agent-version/v1",
  ok: true,
  agentId: "terra",
  version: {
    revision,
    opId: `op-${revision}`,
    sha256: sha("a"),
    size: 100,
    occurredAt: "2026-10-26T00:00:01.000Z",
    actor: { personId: "person-b", executorId: null },
    current: revision === live,
    summary: "instructions 100 B · 0 skills · 1 runtime",
  },
  current: { revision: live, sha256: sha("c") },
  declaration: {
    schema: "agent-declaration/v1",
    id: "terra",
    name: "Terra",
    instructions: "first body",
    runtimes: [{ type: "codex" }],
  },
  fields: [
    {
      field: "instructions",
      kind: "changed",
      lines: [
        { kind: "remove", oldLineNo: 1, text: "first body" },
        { kind: "add", newLineNo: 1, text: "third body" },
      ],
    },
  ],
  truncated: false,
});

describe("agent version panel", () => {
  it("lists every daemon version newest-first and marks the live one", async () => {
    vi.spyOn(agentEntityClient, "readAgentHistory").mockResolvedValue(historyFixture(3));
    mount(
      createElement(AgentVersionPanel, {
        repoId: "repo-a",
        agentId: "terra",
        revision: 3,
        retired: false,
        busy: false,
        onSave: () => undefined,
      }),
    );
    await flushQueries();
    const rows = [...document.querySelectorAll('[data-testid^="agent-version-row-"]')];
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "agent-version-row-3",
      "agent-version-row-2",
      "agent-version-row-1",
    ]);
    expect(rows[0]!.textContent).toContain(t("agentRuntime.versionCurrent"));
    expect(rows[2]!.textContent).toContain(t("agentRuntime.versionSummaryAbsent"));
  });

  it("rolls back by handing the selected body and the detail revision to the same save path", async () => {
    vi.spyOn(agentEntityClient, "readAgentHistory").mockResolvedValue(historyFixture(3));
    vi.spyOn(agentEntityClient, "readAgentVersion").mockResolvedValue(versionFixture(1, 3));
    const onSave = vi.fn();
    mount(
      createElement(AgentVersionPanel, {
        repoId: "repo-a",
        agentId: "terra",
        revision: 3,
        retired: false,
        busy: false,
        onSave,
      }),
    );
    await flushQueries();
    await act(async () => byTestId("agent-version-row-1")!.click());
    await flushQueries();
    // The selected version's field difference is rendered as a diff, not a JSON blob.
    expect(byTestId("agent-version-diff")).not.toBeNull();
    const rollback = byTestId("agent-version-rollback") as HTMLButtonElement;
    expect(rollback.disabled).toBe(false);
    await act(async () => rollback.click());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: "terra", instructions: "first body" });
    expect(onSave.mock.calls[0]![1]).toBe(3);
  });

  it("stands on the current version before any click, so the panel is never an empty right column", async () => {
    vi.spyOn(agentEntityClient, "readAgentHistory").mockResolvedValue(historyFixture(3));
    const read = vi.spyOn(agentEntityClient, "readAgentVersion").mockResolvedValue(versionFixture(3, 3));
    mount(
      createElement(AgentVersionPanel, {
        repoId: "repo-a",
        agentId: "terra",
        revision: 3,
        retired: false,
        busy: false,
        onSave: () => undefined,
      }),
    );
    await flushQueries();
    // No click: the detail revision is what the panel stands on, and the version read already ran.
    expect(read).toHaveBeenCalledWith("repo-a", "terra", 3);
    expect(byTestId("agent-version-row-3")!.getAttribute("aria-current")).toBe("true");
    expect(byTestId("agent-version-detail")).not.toBeNull();
    expect((byTestId("agent-version-rollback") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables rollback on the current version instead of offering a no-op write", async () => {
    vi.spyOn(agentEntityClient, "readAgentHistory").mockResolvedValue(historyFixture(3));
    vi.spyOn(agentEntityClient, "readAgentVersion").mockResolvedValue(versionFixture(3, 3));
    mount(
      createElement(AgentVersionPanel, {
        repoId: "repo-a",
        agentId: "terra",
        revision: 3,
        retired: false,
        busy: false,
        onSave: () => undefined,
      }),
    );
    await flushQueries();
    await act(async () => byTestId("agent-version-row-3")!.click());
    await flushQueries();
    expect((byTestId("agent-version-rollback") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps rollback disabled for a retired agent, because install refuses it", async () => {
    vi.spyOn(agentEntityClient, "readAgentHistory").mockResolvedValue(historyFixture(3));
    vi.spyOn(agentEntityClient, "readAgentVersion").mockResolvedValue(versionFixture(1, 3));
    mount(
      createElement(AgentVersionPanel, {
        repoId: "repo-a",
        agentId: "terra",
        revision: 3,
        retired: true,
        busy: false,
        onSave: () => undefined,
      }),
    );
    await flushQueries();
    await act(async () => byTestId("agent-version-row-1")!.click());
    await flushQueries();
    expect((byTestId("agent-version-rollback") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("GUI agent save carries the revision fence", () => {
  it("passes the read revision to the daemon write and reports a conflict as an actionable reload", async () => {
    const save = vi.spyOn(agentEntityClient, "saveAgent").mockResolvedValue({
      outcome: "op_rejected",
      opId: "op-conflict",
      error: {
        code: "revision_conflict",
        hint: "agent terra expected revision 3, current revision is 4.",
      },
    });
    let savePromise: Promise<unknown> | undefined;
    mount(
      createElement(function Probe() {
        const workspace = useAgentSquadWorkspace("repo-a", null);
        return createElement(
          "button",
          {
            "data-testid": "save-probe",
            onClick: () => {
              savePromise = workspace.saveAgent({ id: "terra", name: "terra" } as never, 3);
            },
          },
          "save",
        );
      }),
    );
    await act(async () => byTestId("save-probe")!.click());
    await act(async () => savePromise);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toMatchObject({ id: "terra" });
    expect(save.mock.calls[0]![2]).toBe(3);
  });

  it("the conflict hint is the daemon's, so the user sees both revisions", () => {
    expect(
      saveFailureHint({
        outcome: "op_rejected",
        error: { code: "revision_conflict", hint: "agent terra expected revision 3, current revision is 4." },
      }),
    ).toBe("agent terra expected revision 3, current revision is 4.");
  });

  it("a first create without a revision still sends expectedVersion 0", async () => {
    const save = vi.spyOn(agentEntityClient, "saveAgent").mockResolvedValue({
      outcome: "applied",
      opId: "op-create",
      revision: 1,
      proof: { durable: true, canonicalVisible: true, worktreeVisible: true },
    });
    let savePromise: Promise<unknown> | undefined;
    mount(
      createElement(function Probe() {
        const workspace = useAgentSquadWorkspace("repo-a", null);
        return createElement(
          "button",
          {
            "data-testid": "create-probe",
            onClick: () => {
              savePromise = workspace.saveAgent({ id: "new-agent", name: "new" } as never);
            },
          },
          "create",
        );
      }),
    );
    await act(async () => byTestId("create-probe")!.click());
    await act(async () => savePromise);
    // No explicit revision: the client's own default is the create fence.
    expect(save.mock.calls[0]![2]).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
