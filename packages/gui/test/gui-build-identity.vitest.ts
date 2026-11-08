// harness-test-tier: fast
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { guiBuildStamp } from "../src/main/gui-build-identity.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it("freezes the loaded bundle identity when the dist marker is rebuilt on disk", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-build-id-"));
  roots.push(root);
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist/build-id.txt"), "8336d23c21\n", "utf8");
  expect(guiBuildStamp(root)).toEqual({ commit: "8336d23c21" });

  writeFileSync(path.join(root, "dist/build-id.txt"), "c3a714be2e\n", "utf8");
  expect(guiBuildStamp(root)).toEqual({ commit: "8336d23c21" });
});
