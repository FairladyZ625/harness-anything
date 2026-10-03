// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  PageRegions,
  RegionDragHandle,
  RegionLayoutControls,
} from "../src/renderer/components/primitives/page-regions.tsx";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const regions = ["plan", "progress", "files"].map((id) => ({
  id,
  title: id,
  content: (
    <section>
      <header>
        <RegionDragHandle />
        {id}
        <RegionLayoutControls />
      </header>
      <button data-body={id}>read {id}</button>
    </section>
  ),
}));
function render(connectionId = "local", repoId = "repo", slot = "page") {
  act(() =>
    root.render(
      <PageRegions
        connectionId={connectionId}
        repoId={repoId}
        slot={slot}
        regions={regions}
        columns={[["plan", "progress"], ["files"]]}
        testId="board"
      />,
    ),
  );
}
function order() {
  return [...host.querySelectorAll<HTMLElement>("[data-region]")].map((node) => node.dataset.region);
}
function key(id: string, value: string) {
  act(() =>
    host
      .querySelector(`[data-testid="region-handle-${id}"]`)!
      .dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })),
  );
}
it("moves any title region across column boundaries, preserves body input, and resets the entire board", () => {
  render();
  expect(order()).toEqual(["plan", "progress", "files"]);
  act(() => host.querySelector<HTMLButtonElement>('[data-body="plan"]')!.click());
  expect(order()).toEqual(["plan", "progress", "files"]);
  key("progress", "ArrowRight");
  expect(order()).toEqual(["plan", "files", "progress"]);
  key("plan", "ArrowDown");
  expect(order()).toEqual(["files", "plan", "progress"]);
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="board-controls-reset"]')!.click());
  expect(order()).toEqual(["plan", "progress", "files"]);
});
it("persists order through remount and isolates connection, repository and page slot", () => {
  render();
  key("plan", "ArrowRight");
  act(() => root.unmount());
  root = createRoot(host);
  render();
  expect(order()).toEqual(["progress", "plan", "files"]);
  render("remote");
  expect(order()).toEqual(["plan", "progress", "files"]);
  render("local", "other");
  expect(order()).toEqual(["plan", "progress", "files"]);
  render("local", "repo", "other-slot");
  expect(order()).toEqual(["plan", "progress", "files"]);
  render();
  expect(order()).toEqual(["progress", "plan", "files"]);
});
it("keeps the original navigation region collapsible after movement and does not activate its body from controls", () => {
  let opened = 0;
  const items = regions.map((region) => ({
    ...region,
    content: (
      <section
        onClick={() => {
          opened += 1;
        }}
      >
        <RegionDragHandle />
        <RegionLayoutControls />
        <p>{region.id}</p>
      </section>
    ),
  }));
  act(() =>
    root.render(
      <PageRegions
        connectionId="local"
        repoId="repo"
        slot="docs"
        collapsible
        regions={items}
        columns={[["plan"], ["progress", "files"]]}
        testId="board"
      />,
    ),
  );
  key("plan", "ArrowRight");
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="board-controls-collapse"]')!.click());
  expect(order()).toEqual(["progress", "files"]);
  expect(opened).toBe(0);
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="board-expand"]')!.click());
  expect(order()).toEqual(["progress", "plan", "files"]);
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="board-controls-reset"]')!.click());
  expect(order()).toEqual(["plan", "progress", "files"]);
  expect(opened).toBe(0);
});
