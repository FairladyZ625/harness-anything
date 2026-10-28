// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act, useState } from "react";
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
  function Controlled() {
    const [value, setValue] = useState("repo");
    return (
      <form onSubmit={submitted}>
        <SegCtl
          label="Scope"
          value={value}
          onChange={(next) => {
            changed(next);
            setValue(next);
          }}
          options={[
            { value: "repo", label: "Repository" },
            { value: "entity", label: "Entity", tip: "Choose an entity" },
          ]}
        />
      </form>
    );
  }
  act(() => root.render(<Controlled />));
  const buttons = container.querySelectorAll("button");
  expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
  expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
  // A6:选中背景是滑块元素(thumb),随选中项移动;未选中项不残留。
  expect(buttons[0].querySelector('[data-testid="seg-ctl-thumb"]')).not.toBeNull();
  expect(buttons[1].querySelector('[data-testid="seg-ctl-thumb"]')).toBeNull();
  act(() => buttons[1].click());
  expect(changed).toHaveBeenCalledWith("entity");
  expect(submitted).not.toHaveBeenCalled();
  expect(buttons[1].dataset.tip).toBe("Choose an entity");
  expect(buttons[1].querySelector('[data-testid="seg-ctl-thumb"]')).not.toBeNull();
  expect(buttons[0].querySelector('[data-testid="seg-ctl-thumb"]')).toBeNull();
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

it("supports a deliberately unselected state", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const changed = vi.fn();
  act(() =>
    root.render(
      <SegCtl
        label="Import mode"
        value={null}
        onChange={changed}
        options={[
          { value: "reference", label: "Reference" },
          { value: "snapshot", label: "Snapshot" },
        ]}
      />,
    ),
  );
  const buttons = container.querySelectorAll("button");
  expect([...buttons].map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
  expect(container.querySelector('[data-testid="seg-ctl-thumb"]')).toBeNull();
  act(() => buttons[0]?.click());
  expect(changed).toHaveBeenCalledWith("reference");
});
