// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

// F-73041008：node-pty 1.1.0 的 npm tarball 不带任何 linux prebuild，Ubuntu 上
// `npm ci` 的 postinstall 必然回退 `node-gyp rebuild` 并联网下载 Node 头文件，
// node-gyp 内置 undici 客户端偶发 assert(!this.paused) 崩溃。node-pty 的
// scripts/prebuild.js 只检查 `prebuilds/<platform>-<arch>` 目录存在与否，所以
// 这里锁定依赖解析到的 node-pty 必须为 CI 安装平台附带可加载的原生模块
// （linux 加载 pty.node、windows 只加载 conpty.node），使安装永远不进入 node-gyp。
test("resolved node-pty ships prebuilds for the CI install platforms", () => {
  const packageRoot = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  const requiredPrebuilds: ReadonlyArray<readonly [platform: string, nativeModule: string]> = [
    ["linux-x64", "pty.node"],
    ["win32-x64", "conpty.node"],
  ];
  for (const [platform, nativeModule] of requiredPrebuilds) {
    const prebuildDir = path.join(packageRoot, "prebuilds", platform);
    assert.ok(
      existsSync(prebuildDir) && readdirSync(prebuildDir).includes(nativeModule),
      `node-pty ${platform}/${nativeModule} prebuild missing: npm ci on ${platform} would fall back to ` +
        "node-gyp, download node headers, and reintroduce the undici assert(!this.paused) CI flake (F-73041008)",
    );
  }
});
