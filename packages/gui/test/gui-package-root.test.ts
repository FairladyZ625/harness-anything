// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appIconPath,
  createPackagedRendererUrl,
  packagedRendererIndexPath,
  resolveGuiPackageRoot,
} from "../src/index.ts";

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

// 图标与渲染层入口不同:它是提交进仓库的成品资产,不是构建产物 —— 所以这里除了
// 路径断言,还断言文件真实存在。文件缺失意味着资源没随包发出,npm 安装里的
// app.dock.setIcon 会拿到空图,Dock 退回默认 Electron 球(阶段一残余风险)。
test("app icon resolves to a committed asset for either main-process entry depth", () => {
  const expected = path.join(packageRoot, "icons/icon.png");
  for (const entry of [devEntry, packagedEntry]) {
    assert.equal(realpathSync(appIconPath(entry)), realpathSync(expected));
  }
  assert.ok(existsSync(expected));
});

// files 数组漏掉 icons/ 时,npm pack 不含图标,上面的路径在干净安装里指向不存在的
// 文件 —— 这是 task_e07b30fd 阶段一列出的残余风险,在此收口为可测断言。
test("npm manifest ships the icons directory with the package", () => {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.ok(
    manifest.files?.includes("icons"),
    "packages/gui package.json files must include icons so the icon ships via npm pack",
  );
});
