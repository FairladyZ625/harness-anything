// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "../src/renderer/theme.tsx";

let root: Root | null = null;
let host: HTMLDivElement;

function ThemeConsumer() {
  const { mode, setMode } = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button data-testid="set-light" onClick={() => setMode("light")}>
        Light
      </button>
      <button data-testid="set-dark" onClick={() => setMode("dark")}>
        Dark
      </button>
    </div>
  );
}

describe("ThemeProvider class and data-theme synchronization", () => {
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    document.documentElement.className = "dark";
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    host.remove();
    localStorage.clear();
  });

  it("defaults to dark theme when localStorage is empty", () => {
    act(() => {
      root!.render(
        <ThemeProvider>
          <ThemeConsumer />
        </ThemeProvider>,
      );
    });

    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("defaults to dark theme when localStorage contains an unrecognized value", () => {
    localStorage.setItem("harness-theme", "unrecognized-value");
    act(() => {
      root!.render(
        <ThemeProvider>
          <ThemeConsumer />
        </ThemeProvider>,
      );
    });

    expect(host.querySelector('[data-testid="mode"]')?.textContent).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes dark class and sets data-theme to light when mode is switched to light", () => {
    localStorage.setItem("harness-theme", "dark");
    act(() => {
      root!.render(
        <ThemeProvider>
          <ThemeConsumer />
        </ThemeProvider>,
      );
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    const lightBtn = host.querySelector('[data-testid="set-light"]') as HTMLButtonElement;
    act(() => {
      lightBtn.click();
    });

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("adds dark class and sets data-theme to dark when mode is switched to dark", () => {
    localStorage.setItem("harness-theme", "light");
    document.documentElement.classList.remove("dark");
    act(() => {
      root!.render(
        <ThemeProvider>
          <ThemeConsumer />
        </ThemeProvider>,
      );
    });

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    const darkBtn = host.querySelector('[data-testid="set-dark"]') as HTMLButtonElement;
    act(() => {
      darkBtn.click();
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
