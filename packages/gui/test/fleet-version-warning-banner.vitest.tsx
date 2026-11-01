// harness-test-tier: fast
// @vitest-environment happy-dom
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { FleetVersionWarningBanner } from "../src/renderer/components/FleetVersionWarningBanner.tsx";

const roots: HTMLElement[] = [];
afterEach(() => roots.splice(0).forEach((host) => host.remove()));

it("shows both build identities and the upgrade command at the shared GUI shell boundary", () => {
  const host = document.createElement("div");
  document.body.append(host);
  roots.push(host);
  act(() => {
    createRoot(host).render(
      <FleetVersionWarningBanner
        warning={{ centerBuildCommit: "center-build", localBuildCommit: "edge-build", upgradeCommand: "ha update" }}
      />,
    );
  });
  expect(host.textContent).toContain("center-build");
  expect(host.textContent).toContain("edge-build");
  expect(host.textContent).toContain("ha update");
});
