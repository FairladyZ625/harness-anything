// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { readDaemonRegistry, registerDaemonRepo, registerDaemonConnection } from "../../kernel/src/index.ts";
import { isRemoteProxyRepo, resolveRepoScopedTarget } from "../src/main/repo-scoped-target.ts";

/**
 * remote-proxy 仓的 repo 作用域 target 解析(PLT-EdgeGUI-W3):
 * daemon 的 resolveLocalDaemonTarget 只认 canonicalRoot 非空的行,proxy 仓会被
 * workspace_not_registered 拒掉;GUI 的数据面仍要经本机 daemon 转发到远端,
 * 所以启用中的 remote-proxy 仓回退到全局 daemon socket(唯一例外,local 语义不放松)。
 */

const strictError = Object.assign(new Error("workspace is not registered"), { code: "workspace_not_registered" });
const strictTarget = { socketPath: "/strict/daemon.sock", userRoot: "/u", daemonId: "default" };
const globalTarget = { socketPath: "/global/daemon.sock", userRoot: "/u", daemonId: "default" };

test("an enabled remote-proxy repo falls back to the global daemon socket", () => {
  const registry = readDaemonRegistry({ userRoot: "/nonexistent-w3" });
  assert.equal(isRemoteProxyRepo(registry, "anything"), false);
});

test("resolveRepoScopedTarget keeps the strict resolution for local repos", () => {
  const target = resolveRepoScopedTarget(
    () => strictTarget,
    () => readDaemonRegistry({ userRoot: "/nonexistent-w3" }),
    () => globalTarget,
    "some-local-repo",
  );
  assert.equal(target.socketPath, "/strict/daemon.sock");
});

test("a resolved local repo never evaluates the registry or the global endpoint", () => {
  const calls: string[] = [];
  const target = resolveRepoScopedTarget(
    () => strictTarget,
    () => {
      calls.push("registry");
      throw new Error("registry must not be read on the strict path");
    },
    () => {
      calls.push("global");
      throw new Error("global target must not be resolved on the strict path");
    },
    "some-local-repo",
  );
  assert.equal(target.socketPath, "/strict/daemon.sock");
  assert.deepEqual(calls, []);
});

test("a strict rejection survives a global endpoint that itself fails to resolve", () => {
  // 回退路径自己会抛(endpoint 与 userRoot 冲突等);它不得替换 strictResolve 的拒绝原因。
  assert.throws(
    () =>
      resolveRepoScopedTarget(
        () => {
          throw strictError;
        },
        () => readDaemonRegistry({ userRoot: "/nonexistent-w3" }),
        () => {
          throw Object.assign(new Error("daemon target conflict"), { code: "daemon_target_conflict" });
        },
        "unknown-repo",
      ),
    /workspace is not registered/u,
  );
});

test("resolveRepoScopedTarget rethrows for unknown or disabled repos", () => {
  assert.throws(
    () =>
      resolveRepoScopedTarget(
        () => {
          throw strictError;
        },
        () => readDaemonRegistry({ userRoot: "/nonexistent-w3" }),
        () => globalTarget,
        "unknown-repo",
      ),
    /workspace is not registered/u,
  );
});

test("resolveRepoScopedTarget routes an enabled remote-proxy row to the global socket", () => {
  const userRoot = `/tmp/ha-w3-target-${process.pid}-${Date.now()}`;
  try {
    registerDaemonConnection({ id: "server-b", endpoint: "tcp://127.0.0.1:19911", userRoot });
    registerDaemonRepo({
      repoId: "proxy-repo",
      mode: "remote-proxy",
      connectionId: "server-b",
      userRoot,
    });
    assert.equal(isRemoteProxyRepo(readDaemonRegistry({ userRoot }), "proxy-repo"), true);
    const target = resolveRepoScopedTarget(
      () => {
        throw strictError;
      },
      () => readDaemonRegistry({ userRoot }),
      () => globalTarget,
      "proxy-repo",
    );
    assert.equal(target.socketPath, "/global/daemon.sock");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
