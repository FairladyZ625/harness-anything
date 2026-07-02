import { describe, expect, it } from "vitest";
import { rendererCapabilityModel, rendererNavigation } from "../src/renderer/app-model.ts";

describe("renderer app model", () => {
  it("keeps the renderer capability model privilege-free", () => {
    expect(rendererCapabilityModel).toEqual({
      nodeGlobalsAvailable: false,
      privilegedModulesAvailable: false,
      receivesOnlyPreloadData: true
    });
  });

  it("keeps primary navigation stable for Vite renderer code", () => {
    expect(rendererNavigation.map((item) => item.id)).toEqual([
      "workspace",
      "board",
      "list",
      "detail",
      "doc-viewer",
      "review-queue",
      "graph"
    ]);
  });
});
