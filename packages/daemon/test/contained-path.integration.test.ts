// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveContainedPath } from "../src/contained-path.ts";
import { resolveRuntimeCwd } from "../src/runtime-spawn-mission.ts";
import { openTerminalHost } from "../src/terminal-host.ts";
import type { TmuxController } from "../src/terminal-tmux.ts";

const symlinkTests = { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false };

test("contained paths canonicalize valid paths and reject symlink escapes", symlinkTests, () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-contained-path-")),
    root = path.join(parent, "repo"),
    outside = path.join(parent, "outside"),
    inside = path.join(root, "inside");
  try {
    mkdirSync(root);
    mkdirSync(outside);
    mkdirSync(inside);
    mkdirSync(path.join(outside, "nested"));
    symlinkSync(outside, path.join(root, "link"), "dir");
    assert.equal(resolveContainedPath(root, "inside"), realpathSync.native(inside));
    assert.equal(resolveContainedPath(root, "."), realpathSync.native(root));
    assert.equal(resolveContainedPath(root, "link"), null);
    assert.equal(resolveContainedPath(root, "link/nested"), null);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runtime cwd rejects symlink escapes", symlinkTests, () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-cwd-")),
    root = path.join(parent, "repo"),
    outside = path.join(parent, "outside");
  try {
    mkdirSync(root);
    mkdirSync(outside);
    mkdirSync(path.join(outside, "nested"));
    symlinkSync(outside, path.join(root, "link"), "dir");
    for (const requestedPath of ["link", "link/nested"]) {
      assert.throws(
        () => resolveRuntimeCwd(root, { scope: "repo-relative", path: requestedPath }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_runtime_cwd",
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("terminal cwd rejects symlink escapes before spawning", symlinkTests, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-terminal-cwd-")),
    root = path.join(parent, "repo"),
    outside = path.join(parent, "outside");
  try {
    mkdirSync(root);
    mkdirSync(outside);
    mkdirSync(path.join(outside, "nested"));
    symlinkSync(outside, path.join(root, "link"), "dir");
    let launches = 0;
    const host = openTerminalHost({
      repoId: "contained-path-terminal",
      rootDir: root,
      daemonGeneration: 1,
      spawnPty: (() => {
        launches += 1;
        return fakePty();
      }) as never,
    });
    try {
      for (const requestedPath of ["link", "link/nested"]) {
        assert.throws(
          () =>
            host.spawn({
              idempotencyKey: `escape-${requestedPath.replaceAll("/", "-")}`,
              backend: "direct-pty",
              cwd: { scope: "repo-relative", path: requestedPath },
              shellProfileId: "default",
              name: "Escape",
            }),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_cwd",
        );
      }
      assert.equal(launches, 0);
    } finally {
      await host.close();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("terminal session restore rejects a symlink escape", symlinkTests, () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-terminal-restore-cwd-")),
    root = path.join(parent, "repo"),
    outside = path.join(parent, "outside"),
    registry = path.join(root, ".harness", "generated", "terminal-sessions.json");
  try {
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, "link"), "dir");
    mkdirSync(path.dirname(registry), { recursive: true });
    writeFileSync(
      registry,
      `${JSON.stringify({
        schema: "terminal-session-registry/v1",
        sessions: [
          {
            sessionId: "terminal-escape",
            idempotencyKey: "escape",
            name: "Escape",
            cwd: "link",
            shellProfile: "bash",
            tmuxNamespace: "escape",
            createdAt: "2026-08-25T00:00:00.000Z",
            lastActivityAt: "2026-08-25T00:00:00.000Z",
          },
        ],
      })}\n`,
    );
    assert.throws(
      () =>
        openTerminalHost({
          repoId: "contained-path-restore",
          rootDir: root,
          daemonGeneration: 1,
          registryFilePath: registry,
          tmux: fakeTmuxController(),
        }),
      /invalid terminal session registry cwd/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function fakePty(): Record<string, unknown> {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
  };
}

function fakeTmuxController(): TmuxController {
  return {
    probe: () => ({ available: true, executable: "/test/tmux", version: "tmux test" }),
    hasSession: () => true,
    killSession: () => undefined,
  };
}
