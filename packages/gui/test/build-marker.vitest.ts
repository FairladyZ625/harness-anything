// harness-test-tier: fast
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const writeScript = new URL("../scripts/write-build-id.mjs", import.meta.url);

describe("gui build marker", () => {
  it("stamps HARNESS_BUILD_COMMIT when the build environment carries one", () => {
    const root = markerFixture();
    try {
      execFileSync(process.execPath, ["scripts/write-build-id.mjs"], {
        cwd: root,
        env: { ...process.env, HARNESS_BUILD_COMMIT: "stamped-commit" },
      });
      expect(readFileSync(path.join(root, "dist/build-id.txt"), "utf8")).toBe("stamped-commit\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the stable archive marker when no git identity resolves", () => {
    const root = markerFixture();
    try {
      const env = { ...process.env };
      delete env.HARNESS_BUILD_COMMIT;
      delete env.GIT_DIR;
      delete env.GIT_WORK_TREE;
      execFileSync(process.execPath, ["scripts/write-build-id.mjs"], { cwd: root, env });
      expect(readFileSync(path.join(root, "dist/build-id.txt"), "utf8")).toBe("source-archive\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The script stamps the dist tree of the package root it sits under (scripts/ -> package root),
// so the copy keeps that layout inside the fixture.
function markerFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-build-marker-"));
  mkdirSync(path.join(root, "dist"));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(writeScript, path.join(root, "scripts/write-build-id.mjs"));
  return root;
}
