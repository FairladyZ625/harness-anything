// harness-test-tier: contract
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewRuntimeDialog } from "../src/renderer/components/runtime/NewRuntimeDialog.tsx";
import { runtimeProviderPlane } from "../src/renderer/runtime-provider-planes.ts";

const installation = {
  installationId: "installation-claude",
  kindId: "claude",
  version: "2.1.260",
  observedAt: "2026-09-13T00:00:00.000Z",
  models: ["claude-fable-5"],
  defaultModel: "claude-fable-5",
} as const;
const dialog = () =>
  renderToStaticMarkup(
    createElement(NewRuntimeDialog, {
      installations: [installation],
      busy: false,
      initialKind: "claude",
      onCancel: () => undefined,
      onCreate: () => undefined,
    }),
  );

describe("claude effort enum", () => {
  it("offers exactly the enum values the launcher forwards as typed", () => {
    const effortSelect = dialog().match(/<select[^>]*aria-label="Effort"[\s\S]*?<\/select>/u)?.[0] ?? "";
    for (const value of runtimeProviderPlane("claude").effortValues) expect(effortSelect).toContain(`value="${value}"`);
    expect(effortSelect).toContain('value=""');
  });
  it("withholds minimal, which the launcher would silently rewrite to low", () => {
    const effortSelect = dialog().match(/<select[^>]*aria-label="Effort"[\s\S]*?<\/select>/u)?.[0] ?? "";
    expect(effortSelect).not.toContain('value="minimal"');
  });
});
