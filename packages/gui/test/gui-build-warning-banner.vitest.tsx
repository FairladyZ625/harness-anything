// harness-test-tier: fast
// @vitest-environment happy-dom
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { GuiBuildWarningBanner } from "../src/renderer/components/GuiBuildWarningBanner.tsx";

const roots: HTMLElement[] = [];
afterEach(() => roots.splice(0).forEach((host) => host.remove()));

function render(guiCommit: string | null | undefined, daemonCommit: string | null | undefined) {
  const host = document.createElement("div");
  document.body.append(host);
  roots.push(host);
  act(() => {
    createRoot(host).render(<GuiBuildWarningBanner guiCommit={guiCommit} daemonCommit={daemonCommit} />);
  });
  return host;
}

it("shows both build identities and the exact GUI rebuild command when they differ", () => {
  const host = render("8336d23c21", "c3a714be2e");
  expect(host.textContent).toContain("8336d23c21");
  expect(host.textContent).toContain("c3a714be2e");
  expect(host.textContent).toContain("npm run build -w @harness-anything/gui");
  expect(host.textContent).toMatch(/restart Electron/iu);
});

it("stays silent when the build identities match or are unavailable", () => {
  expect(render("c3a714be2e", "c3a714be2e").textContent).toBe("");
  expect(render(null, "c3a714be2e").textContent).toBe("");
  expect(render("8336d23c21", null).textContent).toBe("");
});
