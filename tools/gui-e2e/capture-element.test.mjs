// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { frameGuards, parseCaptureArgs, parseMatrix } from "./capture-element.mjs";

test("parseMatrix accepts theme@width[+reduced] combos and rejects anything else", () => {
  assert.deepEqual(parseMatrix("dark@1440"), [{ theme: "dark", width: 1440, reduced: false }]);
  assert.deepEqual(parseMatrix("dark@1440, light@1120+reduced"), [
    { theme: "dark", width: 1440, reduced: false },
    { theme: "light", width: 1120, reduced: true },
  ]);
  assert.throws(() => parseMatrix("sepia@1440"), /矩阵项无法解析/);
  assert.throws(() => parseMatrix("dark"), /矩阵项无法解析/);
  assert.throws(() => parseMatrix("dark@200"), /宽度过窄/);
});

test("parseCaptureArgs groups --name/--scroll with their nearest --selector", () => {
  const options = parseCaptureArgs([
    "--code-tree",
    "/tmp/tree",
    "--out",
    "/tmp/out",
    "--selector",
    "[data-region-scroll]",
    "--scroll",
    "bottom",
    "--selector",
    '[data-testid="catalog-supersede-chain"]',
    "--name",
    "chain",
    "--scroll-x",
    "right",
  ]);
  assert.equal(options.targets.length, 2);
  assert.deepEqual(options.targets[0], {
    selector: "[data-region-scroll]",
    name: "data-region-scroll",
    scroll: "bottom",
    scrollX: null,
  });
  assert.equal(options.targets[1].name, "chain");
  assert.equal(options.targets[1].scrollX, "right");
  assert.deepEqual(options.combos, [{ theme: "dark", width: 1440, reduced: false }]);
});

test("parseCaptureArgs rejects missing required flags, stray modifiers and bad values", () => {
  assert.throws(() => parseCaptureArgs(["--out", "/tmp/out", "--selector", "div"]), /缺少 --code-tree/);
  assert.throws(() => parseCaptureArgs(["--code-tree", "/tmp/tree", "--selector", "div"]), /缺少 --out/);
  assert.throws(() => parseCaptureArgs(["--code-tree", "/tmp/tree", "--out", "/tmp/o"]), /至少需要一个 --selector/);
  assert.throws(() => parseCaptureArgs(["--code-tree", "/t", "--out", "/o", "--name", "x"]), /必须跟在某个 --selector/);
  assert.throws(
    () => parseCaptureArgs(["--code-tree", "/t", "--out", "/o", "--selector", "div", "--scroll", "up"]),
    /--scroll 只认/,
  );
  assert.throws(
    () => parseCaptureArgs(["--code-tree", "/t", "--out", "/o", "--selector", "div", "--pad", "-1"]),
    /--pad/,
  );
  assert.throws(() => parseCaptureArgs(["--code-tree", "/t", "--out", "/o", "--selector", "div", "--wat"]), /未知参数/);
  assert.throws(
    () => parseCaptureArgs(["--code-tree", "/t", "--out", "/o", "--selector", "div", "--route", "catalog.html"]),
    /--route/,
  );
});

test("parseCaptureArgs disambiguates derived target names", () => {
  const options = parseCaptureArgs([
    "--code-tree",
    "/t",
    "--out",
    "/o",
    "--selector",
    "[data-testid=a]",
    "--selector",
    '[data-testid="a"]',
  ]);
  assert.deepEqual(
    options.targets.map((target) => target.name),
    ["data-testid-a", "data-testid-a-2"],
  );
});

test("frameGuards clips a normal element with padding", () => {
  const { clip } = frameGuards(
    {
      present: true,
      chainVisible: true,
      opacity: 1,
      bbox: { x: 100, y: 200, width: 50, height: 60 },
      painted: { x: 100, y: 200, width: 50, height: 60 },
      view: { x: 0, y: 0, width: 1440, height: 900 },
      doc: { width: 1440, height: 2000 },
    },
    { pad: 24, name: "t" },
  );
  assert.deepEqual(clip, { x: 76, y: 176, width: 98, height: 108 });
});

test("frameGuards keeps elements wider than the viewport fully inside the clip", () => {
  // 实测场景:chain-strip 1676px 宽,视口 1440px。文档坐标 clip + fullPage 才装得下。
  const { clip } = frameGuards(
    {
      present: true,
      chainVisible: true,
      opacity: 1,
      bbox: { x: 118, y: 300, width: 1676, height: 40 },
      painted: { x: 118, y: 300, width: 1676, height: 40 },
      view: { x: 118, y: 0, width: 1440, height: 900 },
      doc: { width: 1800, height: 2000 },
    },
    { pad: 24 },
  );
  assert.equal(clip.x, 94);
  // 文档右缘只裁掉外扩 padding(94+1706=1800=doc 边),元素右缘 1794 仍在 clip 内。
  assert.equal(clip.width, 1706);
  assert.ok(clip.x <= 118 && clip.x + clip.width >= 118 + 1676, "clip must cover the whole strip");
});

test("frameGuards frames only the slice a scroll container actually paints", () => {
  // 重拍轮实证:966px 的 prose 在 230px 滚动口里,只有切片画得出来;clip 框切片,
  // 不把画不出的部分当「已入画」。
  const { clip } = frameGuards(
    {
      present: true,
      chainVisible: true,
      opacity: 1,
      bbox: { x: 400, y: 500, width: 1326, height: 966 },
      painted: { x: 400, y: 500, width: 1326, height: 230 },
      view: { x: 0, y: 0, width: 1440, height: 900 },
      doc: { width: 1800, height: 2000 },
    },
    { pad: 24 },
  );
  assert.equal(clip.y, 476);
  assert.equal(clip.height, 278);
});

test("frameGuards clamps the clip at the document origin", () => {
  const { clip } = frameGuards(
    {
      present: true,
      chainVisible: true,
      opacity: 1,
      bbox: { x: 5, y: 5, width: 100, height: 100 },
      painted: { x: 5, y: 5, width: 100, height: 100 },
      view: { x: 0, y: 0, width: 1440, height: 900 },
      doc: { width: 1440, height: 900 },
    },
    { pad: 24 },
  );
  assert.equal(clip.x, 0);
  assert.equal(clip.y, 0);
});

test("frameGuards rejects the observed failure classes and missing targets", () => {
  const base = {
    present: true,
    chainVisible: true,
    opacity: 1,
    bbox: { x: 100, y: 200, width: 50, height: 60 },
    painted: { x: 100, y: 200, width: 50, height: 60 },
    view: { x: 0, y: 0, width: 1440, height: 900 },
    doc: { width: 1440, height: 2000 },
  };
  // 元素画面上完全画不出来:在滚动口/裁剪祖先之外,或根本不在屏幕上(页面顶部失真类)。
  assert.throws(
    () => frameGuards({ ...base, painted: { x: 0, y: 0, width: 0, height: 0 } }, { name: "gone" }),
    /没有可拍内容/,
  );
  // 空白画面:DOM 在、样式对,但祖先 opacity 把它压没了(空白抽屉失真类)。
  assert.throws(() => frameGuards({ ...base, opacity: 0.05 }, { name: "faint" }), /有效透明度/);
  assert.throws(() => frameGuards({ ...base, chainVisible: false, faintChain: ["div.shell"] }), /隐藏链/);
  assert.throws(() => frameGuards({ present: false, matches: 0 }), /未匹配/);
  assert.throws(() => frameGuards({ ...base, bbox: { x: 10, y: 10, width: 0, height: 0 } }), /包围盒/);
});
