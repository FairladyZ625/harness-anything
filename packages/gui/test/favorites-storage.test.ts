import assert from "node:assert/strict";
import test from "node:test";

/**
 * favorites.ts 的持久化是 localStorage + React state。Node test 环境(window undefined)
 * 无法直接驱动 React hook,但可以验证模块在 window 缺失时不抛错(降级路径)。
 *
 * 真正的 hook 行为(读写 localStorage)由 React 渲染时驱动,这里只做模块加载冒烟。
 */
test("favorites module loads without window and exports useFavorites", async () => {
  const mod = await import("../src/renderer/model/favorites.ts");
  assert.equal(typeof mod.useFavorites, "function", "useFavorites must be exported");
});

test("favorites module does not import privileged surface", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync("packages/gui/src/renderer/model/favorites.ts", "utf8"),
  );
  // 仅允许 window.localStorage(渲染层标准 API),禁 node:/electron。
  assert.equal(/\bfrom\s+["'](?:node:)?(?:fs|child_process|path|os|electron)["']/.test(source), false);
});
