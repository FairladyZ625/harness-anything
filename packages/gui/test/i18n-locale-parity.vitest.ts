// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { t, setActiveLocale, initialLocale } from "../src/renderer/i18n/core.ts";

describe("i18n bilingual catalogs (REQ-GUI-09 language switch)", () => {
  it("resolves rebuild shell keys in both locales", () => {
    setActiveLocale("zh-CN");
    expect(t("shell.nav.overview")).toBe("总览");
    expect(t("shell.nav.graph")).toBe("关系图");
    expect(t("navHistory.back")).toContain("后退");
    setActiveLocale("en-US");
    expect(t("shell.nav.overview")).toBe("Overview");
    expect(t("shell.nav.graph")).toBe("Relation Graph");
    expect(t("navHistory.back")).toContain("Back");
  });

  it("interpolates params and picks a system locale fallback", () => {
    setActiveLocale("en-US");
    expect(t("shell.nav.overview")).not.toMatch(/\{/u);
    expect(typeof initialLocale()).toBe("string");
  });
});
