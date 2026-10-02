// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MarkdownDocument } from "../src/renderer/components/MarkdownDocument.tsx";
const render = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render } }));

it("replaces a successful diagram with an error when the same document changes to invalid source", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render.mockResolvedValueOnce({ svg: "<svg><text>Old diagram</text></svg>" });
    await act(async () => root.render(<MarkdownDocument content={"```mermaid\ngraph TD; A-->B\n```"} />));
    await vi.waitFor(() => expect(host.textContent).toContain("Old diagram"));
    render.mockRejectedValueOnce(new Error("Invalid diagram"));
    await act(async () => root.render(<MarkdownDocument content={"```mermaid\nbroken syntax\n```"} />));
    await vi.waitFor(() => expect(host.textContent).toContain("Invalid diagram"));
    expect(host.textContent).not.toContain("Old diagram");
    render.mockResolvedValueOnce({ svg: "<svg><text>New diagram</text></svg>" });
    await act(async () => root.render(<MarkdownDocument content={"```mermaid\ngraph TD; C-->D\n```"} />));
    await vi.waitFor(() => expect(host.textContent).toContain("New diagram"));
    expect(host.textContent).not.toContain("Invalid diagram");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    error.mockRestore();
  }
});
