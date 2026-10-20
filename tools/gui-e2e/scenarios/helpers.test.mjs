// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { assertUnfilteredOverlayState } from "./helpers.mjs";

const healthy = {
  panelFilter: "none",
  panelBackdropFilter: "none",
  ancestorFilters: [],
  scrimFilter: "none",
  scrimBackdropFilter: "none",
};

test("overlay filter contract accepts a clean modal surface", () => {
  assert.doesNotThrow(() => assertUnfilteredOverlayState(healthy, "modal"));
});

test("overlay filter contract rejects blur on the modal scrim (negative control)", () => {
  assert.throws(
    () => assertUnfilteredOverlayState({ ...healthy, scrimBackdropFilter: "blur(18px)" }, "modal"),
    /backdrop-filter=blur\([^)]*\).*必须为 none/u,
  );
});
