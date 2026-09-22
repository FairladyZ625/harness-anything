// harness-test-tier: contract
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPackagedRendererUrl, packagedRendererIndexPath, resolveGuiPackageRoot } from "../src/index.ts";

// 外部锚:包根由本测试文件的已知位置算出(<pkg>/test/ 的上一级),不经被测实现,
// 否则断言会退化成实现与自身的同一性检查。
const packageRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")),
  // 主进程两个深度不同的支持入口:dev 走源文件,npm 通路走打包产物。
  devEntry = pathToFileURL(path.join(packageRoot, "src/main/electron-main.ts")).href,
  packagedEntry = pathToFileURL(path.join(packageRoot, "dist-electron/electron-main.js")).href;

// 这一条是本次白屏回归的分辨力所在:旧实现是 path.resolve(dirname, "../.."),
// 对 dev 入口正确、对打包入口多退一级到 packages/,于是 preload 与渲染层双双 404
// 而窗口标题照常正确。任何按目录深度算包根的实现都会让下面两个 assert 之一变红。
test("package root resolves to the same installed package from either main-process entry depth", () => {
  assert.equal(realpathSync(resolveGuiPackageRoot(devEntry)), packageRoot);
  assert.equal(realpathSync(resolveGuiPackageRoot(packagedEntry)), packageRoot);
});

// 纯路径比较,不碰文件系统:dist/ 是构建产物,未构建的工作区里不存在,断言不该
// 绑在它是否已经构建上。
test("packaged renderer entry stays inside the package for either entry depth", () => {
  const expected = path.join(packageRoot, "dist/index.html");
  for (const entry of [devEntry, packagedEntry]) {
    assert.equal(packagedRendererIndexPath(entry), expected);
    assert.equal(createPackagedRendererUrl(entry), pathToFileURL(expected).href);
  }
});
