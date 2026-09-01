// harness-test-tier: fast
import { describe, expect, it, vi } from "vitest";
import {
  browserLoadError,
  createBrowserShell,
  ensureUrlScheme,
  type BrowserShellState,
} from "../src/renderer/browser/BrowserShell.ts";

class FakeWebview extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly loadURL = vi.fn(async () => undefined);
  readonly goBack = vi.fn();
  readonly goForward = vi.fn();
  readonly reload = vi.fn();
  readonly stop = vi.fn();
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  getURL() {
    return "https://example.com/next";
  }
  canGoBack() {
    return true;
  }
  canGoForward() {
    return false;
  }
}

describe("BrowserShell", () => {
  it("normalizes address-bar input without changing explicit schemes", () => {
    expect(ensureUrlScheme(" example.com/docs ")).toBe("https://example.com/docs");
    expect(ensureUrlScheme("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(ensureUrlScheme("javascript:alert(1)")).toBe("javascript:alert(1)");
  });

  it("drives the engine-neutral navigation contract and reports navigation state", async () => {
    const element = new FakeWebview();
    const states: BrowserShellState[] = [];
    const shell = createBrowserShell(element as unknown as HTMLElement, (state) => states.push(state));
    shell.navigate("https://example.com");
    shell.back();
    shell.forward();
    shell.reload();
    shell.stop();
    element.dispatchEvent(new Event("did-navigate"));
    expect(element.loadURL).toHaveBeenCalledWith("https://example.com");
    expect(element.goBack).toHaveBeenCalledOnce();
    expect(element.goForward).toHaveBeenCalledOnce();
    expect(element.reload).toHaveBeenCalledOnce();
    expect(element.stop).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ url: "https://example.com/next", canGoBack: true, canGoForward: false });
    shell.dispose();
  });

  it("ignores ERR_ABORTED and exposes other load failures", () => {
    expect(browserLoadError(Object.assign(new Event("did-fail-load"), { errorCode: -3 }))).toBeNull();
    expect(
      browserLoadError(
        Object.assign(new Event("did-fail-load"), {
          errorCode: -105,
          errorDescription: "NAME_NOT_RESOLVED",
          validatedURL: "https://missing.invalid",
        }),
      ),
    ).toEqual({ code: -105, description: "NAME_NOT_RESOLVED", url: "https://missing.invalid" });
  });
});
