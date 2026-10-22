// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SystemRepoRow } from "../src/renderer/api-client.ts";
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

const LINK = "harness-edge://join/eyJ2ZXJzaW9uIjoxLCJqb2luSWQiOiJqb2luLTEiLCJ0b2tlbiI6Im9wYXF1ZS10b2tlbiJ9";

function repoRow(overrides: { readonly repoId: string; readonly displayName: string }): SystemRepoRow {
  return {
    canonicalRoot: `/repo/${overrides.repoId}`,
    authoredBranch: "main",
    registrationState: "enabled",
    mode: "local",
    connectionId: "local",
    cellState: "attached",
    generation: 1,
    queueDepth: 0,
    lockState: "not_applicable",
    recoveryMs: null,
    lastError: null,
    unavailableReason: null,
    ...overrides,
  };
}

const REPOS = [
  repoRow({ repoId: "repo-a", displayName: "Alpha Workspace" }),
  repoRow({ repoId: "repo-b", displayName: "repo-b" }),
];
const GROUPS = [
  {
    id: "viewer",
    displayName: "Viewer",
    scopes: ["repo-read"],
    composites: [],
    effectiveScopes: ["repo-read"],
    version: "viewer-v1",
  },
  {
    id: "contributor",
    displayName: "Contributor",
    scopes: ["task-create"],
    composites: ["viewer"],
    effectiveScopes: ["repo-read", "task-create"],
    version: "contributor-v1",
  },
] as const;
const ACTIONS = [
  {
    action: "repo-read",
    presentation: { domain: "repositories", name: "读取仓库", description: "查看仓库内容" },
    executionClass: "repo-read",
    policyTier: "viewer",
    residencyScope: "canonical",
  },
  {
    action: "task-create",
    presentation: { domain: "records", name: "创建记录", description: "创建任务记录" },
    executionClass: "repo-write",
    policyTier: "contributor",
    residencyScope: "canonical",
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
    expiresAt: "2030-01-01T00:00:00.000Z",
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
    expiresAt: "2030-01-01T00:00:00.000Z",
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
    readonly repos?: readonly SystemRepoRow[];
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
        groups: async () => ({ ok: true, groups: GROUPS, actions: ACTIONS }),
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
    root.render(
      createElement(QueryClientProvider, { client }, createElement(EdgeInvitePanel, { repos: options.repos ?? REPOS })),
    );
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
    expect(container.textContent).toContain("2030-01-01");
    expect(list).toHaveBeenCalled();
    expect(container.textContent).toContain("Pending");
  });

  it("lists repositories by display name, keeping the repo id secondary only when they differ", async () => {
    const { container, issue } = await mountPanel({
      repos: [
        repoRow({ repoId: "canonical", displayName: "harness-anything" }),
        repoRow({ repoId: "same-name", displayName: "same-name" }),
        repoRow({ repoId: "no-name", displayName: "" }),
      ],
    });
    const row = (repoId: string) =>
      container.querySelector(`[data-testid="edge-invite-repo-${repoId}"]`)?.closest("label");
    // The owner's exact case: the row reads by its name, like the local list on the left.
    expect(row("canonical")?.textContent).toContain("harness-anything");
    expect(row("canonical")?.textContent).toContain("canonical");
    // When the name already is the id, or the name is empty so the id is the label,
    // the id is not printed a second time.
    expect(row("same-name")?.textContent?.match(/same-name/g)).toHaveLength(1);
    expect(row("no-name")?.textContent?.match(/no-name/g)).toHaveLength(1);
    // What goes to the daemon is still the repo id, never the display name.
    await pick(container, "edge-invite-person-select", "person-gui");
    await check(container, "edge-invite-repo-canonical");
    await check(container, "edge-invite-group-contributor");
    await click(container, "edge-invite-issue");
    expect(issue).toHaveBeenCalledWith({
      personId: "person-gui",
      repoIds: ["canonical"],
      groupIds: ["contributor"],
    });
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

  it("previews each group's effective permissions and marks the inherited ones", async () => {
    const { container } = await mountPanel();
    expect(container.querySelector('[data-testid="edge-invite-group-preview-contributor"]')).toBeNull();
    await click(container, "edge-invite-group-preview-toggle-contributor");
    const preview = container.querySelector('[data-testid="edge-invite-group-preview-contributor"]');
    expect(preview?.textContent).toContain("task-create");
    expect(preview?.textContent).toContain("repo-read");
    // repo-read comes from the inherited viewer group; task-create is the group's own.
    expect(preview?.textContent).toContain("inherited from Read only (viewer)");
    const ownRow = [...preview!.querySelectorAll("p")].find((row) => row.textContent!.includes("task-create"));
    expect(ownRow?.textContent).not.toContain("inherited from");
    // Collapsing hides the preview again.
    await click(container, "edge-invite-group-preview-toggle-contributor");
    expect(container.querySelector('[data-testid="edge-invite-group-preview-contributor"]')).toBeNull();
    // A base group inherits nothing, so its preview carries no inherited marks.
    await click(container, "edge-invite-group-preview-toggle-viewer");
    const viewerPreview = container.querySelector('[data-testid="edge-invite-group-preview-viewer"]');
    expect(viewerPreview?.textContent).toContain("repo-read");
    expect(viewerPreview?.textContent).not.toContain("inherited from");
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
