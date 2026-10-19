// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { EdgeInvitePanel } from "../src/renderer/views/settings/EdgeInvitePanel.tsx";

vi.mock("motion/react", async (original) => {
  const actual = await original<typeof import("motion/react")>();
  return {
    ...actual,
    motion: { div: "div", span: "span" },
    AnimatePresence: ({ children }: { readonly children: unknown }) => children,
    useReducedMotion: () => false,
  };
});

const LINK = "https://center.example/join#v=1&join=join-1&token=opaque-token";
const REPOS = [{ repoId: "repo-a" }, { repoId: "repo-b" }] as const;
const GROUPS = [
  { id: "viewer", displayName: "Viewer", effectiveScopes: ["repo-read"], version: "viewer-v1" },
  {
    id: "contributor",
    displayName: "Contributor",
    effectiveScopes: ["repo-read", "task-create"],
    version: "contributor-v1",
  },
] as const;

function issuedReply(joinId = "join-1") {
  return {
    ok: true,
    joinId,
    state: "pending",
    expiresAt: "2026-10-21T00:00:00.000Z",
    inviteLink: LINK,
  };
}

function join(state: "pending" | "consumed" | "expired" | "revoked" = "pending") {
  return {
    joinId: "join-1",
    state,
    personId: "person-gui",
    repoIds: ["repo-a", "repo-b"],
    groupIds: ["contributor"],
    createdAt: "2026-10-18T00:00:00.000Z",
    expiresAt: "2026-10-21T00:00:00.000Z",
  };
}

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Harness {
  readonly container: HTMLElement;
  readonly issue: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly revoke: ReturnType<typeof vi.fn>;
}

async function mountPanel(options: { readonly issueResult?: unknown; readonly listResults?: readonly unknown[] } = {}) {
  const listQueue = [...(options.listResults ?? [{ ok: true, joins: [join()] }])],
    issue =
      options.issueResult === undefined ? vi.fn(async () => issuedReply()) : vi.fn(async () => options.issueResult),
    list = vi.fn(async () => (listQueue.length > 1 ? listQueue.shift()! : listQueue[0])),
    revoke = vi.fn(async () => ({ ok: true, joinId: "join-1", state: "revoked" }));
  vi.stubGlobal("window", {
    setTimeout: (handler: TimerHandler, ms?: number) => globalThis.setTimeout(handler, ms),
    harness: {
      access: {
        groups: async () => ({ ok: true, groups: GROUPS, actions: [] }),
        issueEdgeJoin: issue,
        edgeJoinList: list,
        revokeEdgeJoin: revoke,
      },
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(EdgeInvitePanel, { repos: REPOS })));
  });
  await settle();
  return { container, issue, list, revoke } satisfies Harness;
}

let flushMacrotask: () => Promise<void> = async () => {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
};

async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1)
    await act(async () => {
      await Promise.resolve();
      await flushMacrotask();
    });
}

async function fill(container: HTMLElement, testId: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  expect(input, `${testId} not rendered`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function check(container: HTMLElement, testId: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  expect(input, `${testId} not rendered`).not.toBeNull();
  await act(async () => {
    input!.click();
  });
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button, `${testId} not rendered`).not.toBeNull();
  await act(async () => button!.click());
  await settle();
}

async function fillInvite(container: HTMLElement): Promise<void> {
  await fill(container, "edge-invite-person-id", "person-gui");
  await fill(container, "edge-invite-username", "edge.operator");
  await fill(container, "edge-invite-email", "edge@example.test");
  await fill(container, "edge-invite-display-name", "Edge Operator");
  await fill(container, "edge-invite-node-label", "edge-boston");
  await check(container, "edge-invite-repo-repo-a");
  await check(container, "edge-invite-repo-repo-b");
  await check(container, "edge-invite-group-contributor");
}

describe("EdgeInvitePanel", () => {
  it("loads effective permission groups and issues one multi-repository invitation", async () => {
    const { container, issue, list } = await mountPanel();
    expect(container.textContent).toContain("Contributor");
    expect(container.textContent).toContain("repo-a");
    expect(container.textContent).toContain("repo-b");
    await fillInvite(container);
    await click(container, "edge-invite-issue");
    expect(issue).toHaveBeenCalledWith({
      personId: "person-gui",
      username: "edge.operator",
      email: "edge@example.test",
      displayName: "Edge Operator",
      repoIds: ["repo-a", "repo-b"],
      groupIds: ["contributor"],
      nodeLabel: "edge-boston",
    });
    expect(container.querySelector('[data-testid="edge-invite-issued"]')?.textContent).toContain(LINK);
    expect(container.textContent).toContain("2026-10-21");
    expect(list).toHaveBeenCalled();
    expect(container.textContent).toContain("Pending");
  });

  it("hides the one-time link on Done while retaining sanitized audit facts", async () => {
    const { container } = await mountPanel();
    await fillInvite(container);
    await click(container, "edge-invite-issue");
    expect(container.textContent).toContain(LINK);
    await click(container, "edge-invite-done");
    expect(container.textContent).not.toContain(LINK);
    expect(container.textContent).toContain("person-gui");
    expect(container.textContent).toContain("repo-a, repo-b");
    expect(container.textContent).toContain("contributor");
  });

  it("polls pending join records until a terminal state", async () => {
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    flushMacrotask = async () => {
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      await vi.advanceTimersByTimeAsync(1);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const { container, list } = await mountPanel({
        listResults: [
          { ok: true, joins: [join("pending")] },
          { ok: true, joins: [join("pending")] },
          { ok: true, joins: [join("consumed")] },
        ],
      });
      expect(container.textContent).toContain("Pending");
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      await settle();
      expect(list).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Pending");
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      await settle();
      expect(container.textContent).toContain("Consumed");
      const callsAtTerminal = list.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      await settle();
      expect(list.mock.calls.length).toBe(callsAtTerminal);
    } finally {
      vi.useRealTimers();
      flushMacrotask = async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      };
    }
  });

  it("revokes a pending invitation through the typed access bridge", async () => {
    const { container, revoke } = await mountPanel();
    await click(container, "edge-invite-revoke-join-1");
    expect(revoke).toHaveBeenCalledWith({ joinId: "join-1" });
  });

  it("surfaces daemon refusal and requires person, repository, and group selections", async () => {
    const refused = await mountPanel({
      issueResult: {
        ok: false,
        code: "authorization_denied",
        error: { code: "authorization_denied", hint: "Sign in as an access administrator." },
      },
    });
    await click(refused.container, "edge-invite-issue");
    expect(refused.issue).not.toHaveBeenCalled();
    expect(refused.container.textContent).toContain("at least one repository");
    await fillInvite(refused.container);
    await click(refused.container, "edge-invite-issue");
    expect(refused.container.textContent).toContain("Sign in as an access administrator.");
    expect(refused.container.textContent).not.toContain(LINK);
  });

  it("copies the HTTPS invite from the one-time display through an isolated clipboard", async () => {
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (text && writes.push(text)) },
    });
    try {
      const { container } = await mountPanel();
      await fillInvite(container);
      await click(container, "edge-invite-issue");
      await click(container, "edge-invite-copy");
      expect(writes).toEqual([LINK]);
    } finally {
      Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: undefined });
    }
  });
});
