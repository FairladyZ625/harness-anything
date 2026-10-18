// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { guiArtifactCacheRoot, guiDaemonReadOnly, guiDaemonUserRoot } from "../src/main/gui-daemon-target.ts";

test("GUI read-only daemon target explicitly follows the host root", () => {
  const env = { HOME: "/isolated/home", HARNESS_GUI_READONLY_DAEMON_USER_ROOT: "/host/.harness" };
  assert.equal(guiDaemonReadOnly(env), true);
  assert.equal(guiDaemonUserRoot(env), "/host/.harness");
});

test("without the override GUI keeps the isolated daemon root", () => {
  const env = { HOME: "/isolated/home" };
  assert.equal(guiDaemonReadOnly(env), false);
  assert.equal(guiDaemonUserRoot(env), "/isolated/home/.harness");
});

test("read-only host attachment keeps artifact materialization in the isolated root", () => {
  const env = {
    HOME: "/isolated/home",
    HARNESS_DAEMON_USER_ROOT: "/isolated/state",
    HARNESS_GUI_READONLY_DAEMON_USER_ROOT: "/host/.harness",
  };
  assert.equal(guiDaemonUserRoot(env), "/host/.harness");
  assert.equal(guiArtifactCacheRoot(env), "/isolated/state/artifact-cache");
});
