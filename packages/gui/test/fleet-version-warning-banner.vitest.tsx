// harness-test-tier: fast
// @vitest-environment happy-dom
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { FleetVersionWarningBanner } from "../src/renderer/components/FleetVersionWarningBanner.tsx";

const roots: HTMLElement[] = [];
afterEach(() => roots.splice(0).forEach((host) => host.remove()));

it("shows an upgrade banner only when the fleet requires an incompatible-version upgrade", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const onOpenUpdates = vi.fn();
  document.body.append(host);
  roots.push(host);
  act(() => {
    root.render(<FleetVersionWarningBanner upgradeRequired={false} onOpenUpdates={onOpenUpdates} />);
  });
  expect(host.textContent).toBe("");
  act(() => {
    root.render(<FleetVersionWarningBanner upgradeRequired={true} onOpenUpdates={onOpenUpdates} />);
  });
  expect(host.textContent).toContain("Fleet protocol or event shape is incompatible");
  expect(host.textContent).toContain("ha edge upgrade");
  const btn = host.querySelector('[data-testid="fleet-version-warning-open-updates"]') as HTMLButtonElement;
  expect(btn).not.toBeNull();
  act(() => {
    btn.click();
  });
  expect(onOpenUpdates).toHaveBeenCalledTimes(1);
});
