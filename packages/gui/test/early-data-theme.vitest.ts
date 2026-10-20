// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.resolve(__dirname, "../index.html");
const earlyThemeJsPath = path.resolve(__dirname, "../public/early-theme.js");

const indexHtml = readFileSync(indexHtmlPath, "utf8");

function loadEarlyThemeScript(): string {
  if (!existsSync(earlyThemeJsPath)) {
    throw new Error(`early-theme.js not found at ${earlyThemeJsPath}`);
  }
  return readFileSync(earlyThemeJsPath, "utf8");
}

function runEarlyThemeScript(options: {
  storedTheme: string | null;
  prefersLight: boolean;
  initialClass?: string;
  simulateStorageError?: boolean;
}) {
  const scriptContent = loadEarlyThemeScript();
  const win = new Window({ url: "http://localhost" });
  const doc = win.document;
  doc.write(
    `<!doctype html><html lang="zh-CN" class="${options.initialClass ?? "dark"}"><head></head><body></body></html>`,
  );

  if (options.simulateStorageError) {
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new Error("SecurityError: localStorage is disabled");
      },
      configurable: true,
    });
  } else if (options.storedTheme !== null) {
    win.localStorage.setItem("harness-theme", options.storedTheme);
  } else {
    win.localStorage.removeItem("harness-theme");
  }

  win.matchMedia = (query: string) =>
    ({
      matches: query.includes("light") ? options.prefersLight : !options.prefersLight,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;

  // Execute the external script in this window context
  win.eval(scriptContent);

  return {
    dataTheme: doc.documentElement.getAttribute("data-theme"),
    datasetTheme: doc.documentElement.dataset.theme,
    classList: Array.from(doc.documentElement.classList),
    hasDarkClass: doc.documentElement.classList.contains("dark"),
  };
}

describe("packages/gui early data-theme external script and index.html wiring", () => {
  it("loads early-theme.js via external <script> in <head> before main.tsx, and contains no inline script", () => {
    // Assert index.html contains no inline script tag (all <script> tags must have src=)
    const inlineScriptMatch = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/iu.exec(indexHtml);
    expect(inlineScriptMatch).toBeNull();

    // Assert <head> contains <script src="./early-theme.js"></script>
    const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/iu.exec(indexHtml);
    expect(headMatch).not.toBeNull();
    const headContent = headMatch![1];
    expect(headContent).toMatch(/<script\s+src=["']\.\/early-theme\.js["']\s*><\/script>/u);

    // Assert early-theme script appears before main.tsx
    const earlyScriptIndex = indexHtml.indexOf('src="./early-theme.js"');
    const mainScriptIndex = indexHtml.indexOf('src="/src/renderer/main.tsx"');
    expect(earlyScriptIndex).toBeGreaterThan(0);
    expect(mainScriptIndex).toBeGreaterThan(earlyScriptIndex);
  });

  it("verifies public/early-theme.js exists on disk", () => {
    expect(existsSync(earlyThemeJsPath)).toBe(true);
  });

  it("defaults to dark theme when stored preference is empty (null), even if system prefers light", () => {
    const result = runEarlyThemeScript({
      storedTheme: null,
      prefersLight: true,
      initialClass: "dark",
    });

    expect(result.dataTheme).toBe("dark");
    expect(result.datasetTheme).toBe("dark");
    expect(result.hasDarkClass).toBe(true);
  });

  it("defaults to dark theme when stored preference is unrecognized, even if system prefers light", () => {
    const result = runEarlyThemeScript({
      storedTheme: "unrecognized-mode",
      prefersLight: true,
      initialClass: "dark",
    });

    expect(result.dataTheme).toBe("dark");
    expect(result.datasetTheme).toBe("dark");
    expect(result.hasDarkClass).toBe(true);
  });

  it('sets data-theme="light" and removes dark class when stored preference is "light"', () => {
    const result = runEarlyThemeScript({
      storedTheme: "light",
      prefersLight: false,
      initialClass: "dark",
    });

    expect(result.dataTheme).toBe("light");
    expect(result.datasetTheme).toBe("light");
    expect(result.hasDarkClass).toBe(false);
  });

  it('maintains dark theme when stored preference is "dark", even if system prefers light', () => {
    const result = runEarlyThemeScript({
      storedTheme: "dark",
      prefersLight: true,
      initialClass: "dark",
    });

    expect(result.dataTheme).toBe("dark");
    expect(result.datasetTheme).toBe("dark");
    expect(result.hasDarkClass).toBe(true);
  });

  it('sets data-theme="light" and removes dark class when stored is "system" and system is light', () => {
    const result = runEarlyThemeScript({
      storedTheme: "system",
      prefersLight: true,
      initialClass: "dark",
    });

    expect(result.dataTheme).toBe("light");
    expect(result.datasetTheme).toBe("light");
    expect(result.hasDarkClass).toBe(false);
  });

  it('maintains dark theme when stored is "system" and system is dark', () => {
    const result = runEarlyThemeScript({
      storedTheme: "system",
      prefersLight: false,
      initialClass: "dark",
    });

    expect(result.dataTheme).toBe("dark");
    expect(result.datasetTheme).toBe("dark");
    expect(result.hasDarkClass).toBe(true);
  });

  it("handles storage exceptions gracefully without throwing or breaking rendering", () => {
    const result = runEarlyThemeScript({
      storedTheme: null,
      prefersLight: false,
      initialClass: "dark",
      simulateStorageError: true,
    });

    expect(result.hasDarkClass).toBe(true);
  });
});
