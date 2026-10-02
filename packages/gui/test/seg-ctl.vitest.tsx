// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SegCtl } from "../src/renderer/components/primitives/SegCtl.tsx";

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
});
it("retains selection semantics and does not submit a containing form", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const changed = vi.fn(),
    submitted = vi.fn();
  act(() =>
    root.render(
      <form onSubmit={submitted}>
        <SegCtl
          label="Scope"
          value="repo"
          onChange={changed}
          options={[
            { value: "repo", label: "Repository" },
            { value: "entity", label: "Entity", tip: "Choose an entity" },
          ]}
        />
      </form>,
    ),
  );
  const buttons = container.querySelectorAll("button");
  expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
  expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
  act(() => buttons[1].click());
  expect(changed).toHaveBeenCalledWith("entity");
  expect(submitted).not.toHaveBeenCalled();
  expect(buttons[1].dataset.tip).toBe("Choose an entity");
});
it("disabled mode prevents changes through native buttons", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const changed = vi.fn();
  act(() =>
    root.render(
      <SegCtl
        disabled
        label="Mode"
        value="local"
        onChange={changed}
        options={[
          { value: "local", label: "Local" },
          { value: "remote", label: "Remote" },
        ]}
      />,
    ),
  );
  expect(container.querySelector('[role="group"]')?.getAttribute("aria-disabled")).toBe("true");
  for (const button of container.querySelectorAll("button")) {
    expect(button.disabled).toBe(true);
    act(() => button.click());
  }
  expect(changed).not.toHaveBeenCalled();
});
