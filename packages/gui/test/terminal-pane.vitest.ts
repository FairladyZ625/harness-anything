// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const xterm = vi.hoisted(() => ({
  loaded: [] as string[],
  lastOptions: null as Record<string, unknown> | null,
  keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  selection: "",
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    #unicode = { activeVersion: "6" };
    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      xterm.lastOptions = options;
    }
    // Mirror xterm's real gate: reading `unicode` (what Unicode11Addon.activate does, and what
    // TerminalPane's `terminal.unicode.activeVersion = "11"` does) throws unless allowProposedApi is on.
    get unicode() {
      if (this.options.allowProposedApi !== true)
        throw new Error("You must set the allowProposedApi option to true to use proposed API");
      return this.#unicode;
    }
    loadAddon(addon: { readonly name: string }) {
      xterm.loaded.push(addon.name);
    }
    open() {}
    onData() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      xterm.keyHandler = handler;
    }
    hasSelection() {
      return xterm.selection.length > 0;
    }
    getSelection() {
      return xterm.selection;
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    focus() {}
    reset() {}
    write() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    name = "fit";
    fit() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    name = "search";
    findNext() {
      return true;
    }
    findPrevious() {
      return true;
    }
  },
}));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    name = "serialize";
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    name = "unicode11";
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    name = "web-links";
    constructor(_handler: unknown) {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    name = "webgl";
  },
}));
vi.mock("../src/renderer/components/terminal/terminal-link-provider.ts", () => ({
  registerTerminalLinks: () => ({ dispose() {} }),
}));

import { TerminalPane } from "../src/renderer/components/terminal/TerminalPane.tsx";
import { terminalWebglStorageKey } from "../src/renderer/terminal-renderer.ts";

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  xterm.loaded = [];
  xterm.keyHandler = null;
  xterm.selection = "";
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function mount() {
  act(() =>
    root.render(
      createElement(TerminalPane, {
        output: "",
        interactive: true,
        onInput: () => undefined,
        onFit: () => undefined,
        openUrl: null,
        onOpenLink: () => undefined,
        onSelectionChange: () => undefined,
      }),
    ),
  );
}

describe("TerminalPane addon lifecycle (W4a)", () => {
  it("loads Unicode 11, serialization and search for every terminal pane", () => {
    mount();
    expect(xterm.loaded).toEqual(["fit", "unicode11", "serialize", "search", "web-links"]);
  });

  // Regression: Unicode11Addon activation and `terminal.unicode.activeVersion = "11"` are xterm
  // proposed API. Constructing the terminal without allowProposedApi threw on mount, crashing every
  // pane (and, with no error boundary, blanking the whole window). Pin the option on.
  it("constructs xterm with allowProposedApi so the pane mounts without throwing", () => {
    expect(() => mount()).not.toThrow();
    expect(xterm.lastOptions?.allowProposedApi).toBe(true);
  });

  // Regression: xterm's DOM renderer measures glyph width from a 32-char repeat; with ligatures on,
  // Geist Mono shapes "----" into one rule and reports ~1/3 of the cell, so every "-"/"=" got padded.
  it("disables font ligatures on the host so xterm's width cache measures real cell advances", () => {
    mount();
    const host = container.querySelector<HTMLElement>('[data-testid="terminal-pane"]');
    expect(host?.style.fontVariantLigatures).toBe("none");
  });

  it("loads WebGL only when the centralized preference opts in", () => {
    localStorage.setItem(terminalWebglStorageKey, "enabled");
    mount();
    expect(xterm.loaded).toContain("webgl");
  });

  it("copies an xterm selection on Cmd+C without forwarding the key", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    xterm.selection = "selected output";
    mount();
    const event = new KeyboardEvent("keydown", { key: "c", metaKey: true, cancelable: true });
    expect(xterm.keyHandler?.(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("selected output");
  });

  it("forwards Ctrl+C and Cmd+C without a selection to the PTY path", () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount();
    expect(xterm.keyHandler?.(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(true);
    expect(xterm.keyHandler?.(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
});
