// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { formatTime } from "../src/renderer/model/time.ts";
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

const LINK = "harness-edge://join/eyJ2ZXJzaW9uIjoxLCJqb2luSWQiOiJqb2luLTEiLCJ0b2tlbiI6Im9wYXF1ZS10b2tlbiJ9";
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
const PEOPLE = [
  { personId: "person-gui", username: "edge.operator" },
  { personId: "person-owner", username: "owner" },
] as const;

function issuedReply(joinId = "join-1") {
  return {
    ok: true,
    joinId,
    state: "pending",
    expiresAt: "2026-10-21T00:00:00.000Z",
    link: LINK,
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Harness {
  readonly container: HTMLElement;
  readonly grants: ReturnType<typeof vi.fn>;
  readonly issue: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
  readonly revoke: ReturnType<typeof vi.fn>;
}

async function mountPanel(
  options: {
    readonly issueResult?: unknown;
    readonly listResults?: readonly unknown[];
    readonly people?: readonly unknown[];
    readonly peopleError?: string;
  } = {},
) {
  const listQueue = [...(options.listResults ?? [{ ok: true, joins: [join()] }])],
    issue =
      options.issueResult === undefined ? vi.fn(async () => issuedReply()) : vi.fn(async () => options.issueResult),
    list = vi.fn(async () => (listQueue.length > 1 ? listQueue.shift()! : listQueue[0])),
    revoke = vi.fn(async () => ({ ok: true, joinId: "join-1", state: "revoked" })),
    grants = vi.fn(async () => {
      if (options.peopleError) throw new Error(options.peopleError);
      return { ok: true, people: options.people ?? PEOPLE, grants: [] };
    });
  vi.stubGlobal("window", {
    setTimeout: (handler: TimerHandler, ms?: number) => globalThis.setTimeout(handler, ms),
    harness: {
      access: {
        groups: async () => ({ ok: true, groups: GROUPS, actions: [] }),
        grants,
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
  return { container, grants, issue, list, revoke } satisfies Harness;
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

async function pick(container: HTMLElement, testId: string, value: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
  expect(select, `${testId} not rendered`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select!, value);
    select!.dispatchEvent(new Event("change", { bubbles: true }));
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

function memberOptionValues(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLSelectElement>('[data-testid="edge-invite-person-select"] option')].map(
    (option) => option.value,
  );
}

/** Invite an existing member: pick them from the list; no identity is typed by hand. */
async function pickExistingMember(container: HTMLElement, personId = "person-gui"): Promise<void> {
  await pick(container, "edge-invite-person-select", personId);
  await check(container, "edge-invite-repo-repo-a");
  await check(container, "edge-invite-repo-repo-b");
  await check(container, "edge-invite-group-contributor");
  await fill(container, "edge-invite-node-label", "edge-boston");
}

/** Invite someone who is not a member yet: the form creates them with a derived member id. */
async function fillNewMember(
  container: HTMLElement,
  fields: { readonly username: string; readonly email: string; readonly displayName: string },
): Promise<void> {
  await pick(container, "edge-invite-person-select", "__new__");
  await fill(container, "edge-invite-username", fields.username);
  await fill(container, "edge-invite-email", fields.email);
  await fill(container, "edge-invite-display-name", fields.displayName);
  await check(container, "edge-invite-repo-repo-a");
  await check(container, "edge-invite-repo-repo-b");
  await check(container, "edge-invite-group-contributor");
}

describe("EdgeInvitePanel", () => {
  it("picks an existing member from a searchable list and issues without any hand-typed identity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"));
    const { container, issue, list, grants } = await mountPanel();
    expect(grants).toHaveBeenCalledTimes(1);
    expect(memberOptionValues(container)).toEqual(["", "__new__", "person-gui", "person-owner"]);
    // Searching narrows the member options by username and person id.
    await fill(container, "edge-invite-person-search", "operator");
    expect(memberOptionValues(container)).toEqual(["", "__new__", "person-gui"]);
    await pickExistingMember(container);
    // A picked member stays selectable even when the search no longer matches them.
    await fill(container, "edge-invite-person-search", "owner");
    expect(memberOptionValues(container)).toEqual(["", "__new__", "person-owner", "person-gui"]);
    // The person id is shown, never typed: no person-id input exists at all.
    expect(container.querySelector('[data-testid="edge-invite-person-id"]')).toBeNull();
    expect(container.querySelector('[data-testid="edge-invite-person-summary"]')?.textContent).toContain(
      "edge.operator (person-gui)",
    );
    await click(container, "edge-invite-issue");
    expect(issue).toHaveBeenCalledWith({
      personId: "person-gui",
      repoIds: ["repo-a", "repo-b"],
      groupIds: ["contributor"],
      nodeLabel: "edge-boston",
    });
    expect(container.querySelector('[data-testid="edge-invite-issued"]')?.textContent).toContain(LINK);
    expect(container.textContent).toContain(formatTime("2026-10-21T00:00:00.000Z", { style: "date-time" }));
    expect(list).toHaveBeenCalled();
    expect(container.textContent).toContain("Pending");
  });

  it("creates a new member in the same form with the derived member id shown", async () => {
    const { container, issue } = await mountPanel();
    await fillNewMember(container, {
      username: "edge.boston",
      email: "boston@example.test",
      displayName: "Edge Boston",
    });
    expect(container.querySelector('[data-testid="edge-invite-new-person-id"]')?.textContent).toContain("edge.boston");
    await fill(container, "edge-invite-node-label", "edge-boston");
    await click(container, "edge-invite-issue");
    expect(issue).toHaveBeenCalledWith({
      personId: "edge.boston",
      username: "edge.boston",
      email: "boston@example.test",
      displayName: "Edge Boston",
      repoIds: ["repo-a", "repo-b"],
      groupIds: ["contributor"],
      nodeLabel: "edge-boston",
    });
    expect(container.querySelector('[data-testid="edge-invite-issued"]')?.textContent).toContain(LINK);
  });

  it("refuses a new member whose username would take an existing member's id", async () => {
    const { container, issue } = await mountPanel();
    await fillNewMember(container, {
      username: "person-gui",
      email: "twin@example.test",
      displayName: "Twin",
    });
    await click(container, "edge-invite-issue");
    expect(issue).not.toHaveBeenCalled();
    expect(container.textContent).toContain("already identifies an existing member");
    expect(container.querySelector('[data-testid="edge-invite-issued"]')).toBeNull();
  });

  it("refuses a new member whose username is already another member's username", async () => {
    const { container, issue } = await mountPanel();
    // The existing member's person id differs from their username; Keycloak still owns the name.
    await fillNewMember(container, {
      username: "owner",
      email: "twin@example.test",
      displayName: "Twin",
    });
    await click(container, "edge-invite-issue");
    expect(issue).not.toHaveBeenCalled();
    expect(container.textContent).toContain("already identifies an existing member");
    expect(container.querySelector('[data-testid="edge-invite-issued"]')).toBeNull();
  });

  it("shows a failed members read instead of claiming the center has no members", async () => {
    const { container } = await mountPanel({ peopleError: "members are unavailable" });
    expect(container.textContent).toContain("members are unavailable");
    expect(container.textContent).not.toContain("No members yet");
  });

  it("offers only the new-member path when the center has no members yet", async () => {
    const { container, issue } = await mountPanel({ people: [] });
    expect(container.textContent).toContain("No members yet");
    expect(memberOptionValues(container)).toEqual(["", "__new__"]);
    await fillNewMember(container, {
      username: "first.member",
      email: "first@example.test",
      displayName: "First Member",
    });
    await click(container, "edge-invite-issue");
    expect(issue).toHaveBeenCalledWith({
      personId: "first.member",
      username: "first.member",
      email: "first@example.test",
      displayName: "First Member",
      repoIds: ["repo-a", "repo-b"],
      groupIds: ["contributor"],
    });
  });

  it("hides the one-time link on Done while retaining sanitized audit facts", async () => {
    const { container } = await mountPanel();
    await pickExistingMember(container);
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

  it("surfaces daemon refusal and requires a member, repository, and group selections", async () => {
    const refused = await mountPanel({
      issueResult: {
        ok: false,
        code: "authorization_denied",
        error: { code: "authorization_denied", hint: "Sign in as an access administrator." },
      },
    });
    await click(refused.container, "edge-invite-issue");
    expect(refused.issue).not.toHaveBeenCalled();
    expect(refused.container.textContent).toContain("Pick an existing member");
    await pickExistingMember(refused.container);
    await click(refused.container, "edge-invite-issue");
    expect(refused.container.textContent).toContain("Sign in as an access administrator.");
    expect(refused.container.textContent).not.toContain(LINK);
  });

  it("copies the pasteable harness-edge link from the one-time display through an isolated clipboard", async () => {
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (text && writes.push(text)) },
    });
    try {
      const { container } = await mountPanel();
      await pickExistingMember(container);
      await click(container, "edge-invite-issue");
      await click(container, "edge-invite-copy");
      expect(writes).toEqual([LINK]);
    } finally {
      Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: undefined });
    }
  });
});
