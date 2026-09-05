// harness-test-tier: integration
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { t, setActiveLocale, initialLocale } from "../src/renderer/i18n/core.ts";
import { RUNTIME_KIND_IDS } from "../src/renderer/runtime-provider-planes.ts";

function catalogKeys(locale: "en-US" | "zh-CN"): string[] {
  const directory = new URL(`../src/renderer/i18n/locales/${locale}/`, import.meta.url);
  return readdirSync(directory)
    .flatMap((file) => Object.keys(JSON.parse(readFileSync(new URL(file, directory), "utf8"))))
    .sort();
}

describe("i18n bilingual catalogs (REQ-GUI-09 language switch)", () => {
  it("keeps the full locale catalog key sets in parity", () => {
    expect(catalogKeys("zh-CN")).toEqual(catalogKeys("en-US"));
  });

  it("interpolates params and picks a system locale fallback", () => {
    setActiveLocale("en-US");
    expect(t("shell.nav.overview")).not.toMatch(/\{/u);
    expect(typeof initialLocale()).toBe("string");
  });

  it("has a plane_<kind> caption for every runtime kind (guards the ZCODE black-screen)", () => {
    const keys = new Set(catalogKeys("zh-CN"));
    for (const kindId of RUNTIME_KIND_IDS)
      expect(keys.has(`agentRuntime.plane_${kindId}`), `missing agentRuntime.plane_${kindId}`).toBe(true);
  });

  it("returns the key itself for a missing message instead of throwing", () => {
    setActiveLocale("zh-CN");
    const missing = "agentRuntime.plane_does_not_exist" as never;
    expect(() => t(missing)).not.toThrow();
    expect(t(missing)).toBe("agentRuntime.plane_does_not_exist");
  });
});
