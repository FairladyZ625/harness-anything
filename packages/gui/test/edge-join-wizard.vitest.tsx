// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { EdgeJoinWizard } from "../src/renderer/components/EdgeJoinWizard.tsx";

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
const DEVICE = {
  pending: true as const,
  verificationUri: "https://login.example.test/device",
  userCode: "ABCD-EFGH",
  interval: 1,
  expiresAt: Date.now() + 60_000,
};
const JOINED = {
  ok: true as const,
  joinId: "join-1",
  state: "synced" as const,
  repoIds: ["repo-a", "repo-b"],
  repositories: [
    { repoId: "repo-a", ok: true },
    { repoId: "repo-b", ok: true },
  ],
};

interface Bridge {
  readonly begin: ReturnType<typeof vi.fn>;
  readonly poll: ReturnType<typeof vi.fn>;
  readonly progress: ReturnType<typeof vi.fn>;
  readonly openLogin: ReturnType<typeof vi.fn>;
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

async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

function installBridge(overrides: Partial<Bridge> = {}): Bridge {
  const bridge: Bridge = {
    begin: vi.fn(async () => JOINED),
    poll: vi.fn(async () => ({ pending: false })),
    progress: vi.fn(async () => ({ ok: true, repositories: [] })),
    openLogin: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  // The wizard resolves the bridge through window.harness on every call, so a plain assignment is enough.
  (window as unknown as { harness?: unknown }).harness = { edgeJoin: bridge };
  return bridge;
}

async function mount(options: { readonly initialLink?: string | null } = {}) {
  const onJoined = vi.fn(),
    onClose = vi.fn(),
    container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(EdgeJoinWizard, {
        open: true,
        initialLink: options.initialLink ?? null,
        onClose,
        onJoined,
      }),
    );
  });
  return { container, onJoined, onClose };
}

function byTestId(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const element = byTestId(container, testId);
  if (element === null) throw new Error(`Missing ${testId}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("edge join wizard", () => {
  it("prefills a protocol link and refuses a malformed one before calling the daemon", async () => {
    const bridge = installBridge();
    const { container } = await mount({ initialLink: LINK });
    const input = byTestId(container, "edge-join-link-input") as HTMLInputElement;
    expect(input.value).toBe(LINK);

    await act(async () => setInputValue(input, "https://example.test/join"));
    await settle(1);
    expect(byTestId(container, "edge-join-link-invalid")?.textContent).toContain("harness-edge://join/");
    expect((byTestId(container, "edge-join-start") as HTMLButtonElement).disabled).toBe(true);

    // The bare scheme prefix is incomplete, not a usable invitation.
    await act(async () => setInputValue(input, "harness-edge://join/"));
    await settle(1);
    expect(byTestId(container, "edge-join-link-invalid")).not.toBeNull();
    expect((byTestId(container, "edge-join-start") as HTMLButtonElement).disabled).toBe(true);
    expect(bridge.begin).not.toHaveBeenCalled();
  });

  it("shows the daemon's device sign-in and opens only the daemon-named page", async () => {
    const bridge = installBridge({ begin: vi.fn(async () => DEVICE) });
    const { container } = await mount();
    await act(async () => setInputValue(byTestId(container, "edge-join-link-input") as HTMLInputElement, LINK));
    await settle(1);
    await click(container, "edge-join-start");
    await settle();

    expect(bridge.begin).toHaveBeenCalledWith({ link: LINK });
    expect(byTestId(container, "edge-join-login-uri")?.textContent).toBe(DEVICE.verificationUri);
    expect(byTestId(container, "edge-join-user-code")?.textContent).toBe(DEVICE.userCode);
    expect(bridge.openLogin).not.toHaveBeenCalled();

    await click(container, "edge-join-open-login");
    expect(bridge.openLogin).toHaveBeenCalledTimes(1);
  });

  it("explains that SSH invitations use the center's browser-accessible device page", async () => {
    installBridge({ begin: vi.fn(async () => ({ ...DEVICE, transport: "ssh-reverse" as const })) });
    const { container } = await mount();
    await act(async () => setInputValue(byTestId(container, "edge-join-link-input") as HTMLInputElement, LINK));
    await settle(1);
    await click(container, "edge-join-start");
    await settle();

    expect(byTestId(container, "edge-join-ssh-browser-handoff")?.textContent).toContain("any device");
    expect(byTestId(container, "edge-join-ssh-browser-handoff")?.textContent).toContain("center computer");
  });

  it("polls after approval, calls the join again, and hands the synced repositories up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const begin = vi
        .fn(async () => DEVICE)
        .mockResolvedValueOnce(DEVICE)
        .mockResolvedValueOnce(JOINED),
      bridge = installBridge({ begin, poll: vi.fn(async () => ({ pending: false })) });
    const { container, onJoined } = await mount();
    await act(async () => setInputValue(byTestId(container, "edge-join-link-input") as HTMLInputElement, LINK));
    await settle(1);
    await click(container, "edge-join-start");
    await settle();
    expect(byTestId(container, "edge-join-user-code")?.textContent).toBe(DEVICE.userCode);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await settle();

    expect(bridge.poll).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(byTestId(container, "edge-join-repositories")?.textContent).toContain("repo-a");
    expect(byTestId(container, "edge-join-repositories")?.textContent).toContain("Synced");
    expect(onJoined).toHaveBeenCalledWith(["repo-a", "repo-b"]);
  });

  it("paints per-repository progress while the join is still running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const bridge = installBridge({
      begin: vi.fn(() => new Promise(() => undefined)),
      progress: vi.fn(async () => ({
        ok: true,
        repositories: [
          { repoId: "repo-a", phase: "workspace" },
          { repoId: "repo-b", phase: "sync" },
        ],
      })),
    });
    const { container } = await mount();
    await act(async () => setInputValue(byTestId(container, "edge-join-link-input") as HTMLInputElement, LINK));
    await settle(1);
    await click(container, "edge-join-start");
    await settle(1);
    expect(byTestId(container, "edge-join-repositories")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await settle();

    expect(bridge.progress).toHaveBeenCalled();
    const rows = byTestId(container, "edge-join-repositories")?.textContent ?? "";
    expect(rows).toContain("repo-a");
    expect(rows).toContain("Preparing workspace");
    expect(rows).toContain("repo-b");
    expect(rows).toContain("First sync");
  });

  it("maps a daemon refusal to one plain reason and the next step", async () => {
    installBridge({ begin: vi.fn(async () => ({ ok: false, code: "pin_mismatch" })) });
    const { container } = await mount();
    await act(async () => setInputValue(byTestId(container, "edge-join-link-input") as HTMLInputElement, LINK));
    await settle(1);
    await click(container, "edge-join-start");
    await settle();

    expect(byTestId(container, "edge-join-error-message")?.textContent).toContain(
      "certificate fingerprint does not match",
    );
    expect(container.textContent).toContain("Confirm the link came from a trusted administrator");
  });

  it("explains an unreachable sign-in service on the first join attempt and keeps the daemon detail", async () => {
    installBridge({
      begin: vi.fn(async () => ({
        ok: false,
        code: "oidc_device_transport_unavailable",
        rejectionExplanation: "fetch failed (cause: connect ECONNREFUSED 127.0.0.1:8443)",
      })),
    });
    const { container } = await mount();
    await act(async () => setInputValue(byTestId(container, "edge-join-link-input") as HTMLInputElement, LINK));
    await settle(1);
    await click(container, "edge-join-start");
    await settle();

    expect(byTestId(container, "edge-join-error-message")?.textContent).toContain(
      "The sign-in service is unreachable.",
    );
    expect(container.textContent).toContain("Check the network and retry");
    expect(byTestId(container, "edge-join-error-detail")?.textContent).toContain("ECONNREFUSED");
  });

  it("shows both unreachable external addresses from the first join probe", async () => {
    installBridge({
      begin: vi.fn(async () => ({
        ok: false,
        code: "edge_join_addresses_unreachable",
        rejectionExplanation:
          "Center service address check failed: https://center.example:7545. Sign-in service address check failed: https://login.example:18544.",
      })),
    });
    const { container } = await mount();
    await act(async () => setInputValue(byTestId(container, "edge-join-link-input") as HTMLInputElement, LINK));
    await settle(1);
    await click(container, "edge-join-start");
    await settle();

    expect(byTestId(container, "edge-join-error-message")?.textContent).toContain(
      "The center and sign-in service addresses could not be reached.",
    );
    expect(container.textContent).toContain("Check both addresses");
    const detail = byTestId(container, "edge-join-error-detail")?.textContent ?? "";
    expect(detail).toContain("center.example:7545");
    expect(detail).toContain("login.example:18544");
  });

  it("keeps waiting when the sign-in service is unreachable and finishes once it recovers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const begin = vi
        .fn(async () => DEVICE)
        .mockResolvedValueOnce(DEVICE)
        .mockResolvedValueOnce(JOINED),
      poll = vi
        .fn(async () => ({ ok: false, code: "oidc_device_transport_unavailable" }))
        .mockResolvedValueOnce({ ok: false, code: "oidc_device_transport_unavailable" })
        .mockResolvedValueOnce({ pending: false });
    installBridge({ begin, poll });
    const { container } = await mount();
    await act(async () => setInputValue(byTestId(container, "edge-join-link-input") as HTMLInputElement, LINK));
    await settle(1);
    await click(container, "edge-join-start");
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await settle();
    expect(byTestId(container, "edge-join-transport-notice")?.textContent).toContain("unreachable");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await settle();
    expect(byTestId(container, "edge-join-repositories")?.textContent).toContain("repo-a");
  });
});
