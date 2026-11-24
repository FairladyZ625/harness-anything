// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import {
  appIconPath,
  createPackagedRendererUrl,
  packagedRendererIndexPath,
  resolveGuiPackageRoot,
} from "../src/index.ts";

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngIhdr {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compression: number;
  filter: number;
  interlace: number;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function parsePng(bytes: Buffer): { ihdr: PngIhdr; idatChunks: Buffer[] } {
  assert.ok(bytes.length >= 33, "PNG file is too small to contain signature and IHDR");
  assert.deepEqual(bytes.subarray(0, 8), pngSignature, "PNG signature mismatch");

  let offset = 8;
  let ihdr: PngIhdr | undefined;
  const idatChunks: Buffer[] = [];
  let sawIend = false;

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= bytes.length, `PNG chunk ${type} exceeds file bounds`);
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      assert.equal(length, 13, "IHDR chunk must be 13 bytes");
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8]!,
        colorType: data[9]!,
        compression: data[10]!,
        filter: data[11]!,
        interlace: data[12]!,
      };
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      sawIend = true;
      break;
    }

    offset = dataEnd + 4;
  }

  assert.ok(ihdr, "PNG is missing IHDR chunk");
  assert.ok(idatChunks.length > 0, "PNG is missing IDAT chunk");
  assert.ok(sawIend, "PNG is missing IEND chunk");
  return { ihdr, idatChunks };
}

function decodeRgba8Pixels(width: number, height: number, idatChunks: Buffer[]): Uint8Array {
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  assert.equal(inflated.length, height * (stride + 1), "decompressed IDAT length does not match 8-bit RGBA scanlines");

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const scanlineOffset = y * (stride + 1);
    const filterType = inflated[scanlineOffset]!;
    const rowOffset = y * stride;

    for (let x = 0; x < stride; x += 1) {
      const rawByte = inflated[scanlineOffset + 1 + x]!;
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel]! : 0;
      const up = y > 0 ? pixels[rowOffset - stride + x]! : 0;
      const upLeft = x >= bytesPerPixel && y > 0 ? pixels[rowOffset - stride + x - bytesPerPixel]! : 0;

      let reconstructed: number;
      if (filterType === 0) {
        reconstructed = rawByte;
      } else if (filterType === 1) {
        reconstructed = (rawByte + left) & 0xff;
      } else if (filterType === 2) {
        reconstructed = (rawByte + up) & 0xff;
      } else if (filterType === 3) {
        reconstructed = (rawByte + ((left + up) >> 1)) & 0xff;
      } else if (filterType === 4) {
        reconstructed = (rawByte + paethPredictor(left, up, upLeft)) & 0xff;
      } else {
        assert.fail(`unsupported PNG filter type ${filterType} on scanline ${y}`);
      }
      pixels[rowOffset + x] = reconstructed;
    }
  }
  return pixels;
}

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

// macOS Dock 图标网格要求外圈保留透明安全留白;若退化为 0px 撑满画布的方块/圆角矩形,
// Dock 图标会在视觉上明显偏大。纯 Node 解析 PNG IHDR + IDAT 保证跨平台 CI 原生可跑。
test("app icon is a 1024x1024 RGBA PNG with Apple macOS squircle safe margin", () => {
  const bytes = readFileSync(path.join(packageRoot, "icons/icon.png"));
  const { ihdr, idatChunks } = parsePng(bytes);

  assert.equal(ihdr.width, 1024, "app icon width must be 1024px");
  assert.equal(ihdr.height, 1024, "app icon height must be 1024px");
  assert.equal(ihdr.bitDepth, 8, "app icon bit depth must be 8-bit");
  assert.equal(ihdr.colorType, 6, "app icon color type must be 6 (RGBA)");
  assert.equal(ihdr.compression, 0, "app icon must use standard deflate compression");
  assert.equal(ihdr.filter, 0, "app icon must use standard adaptive filtering");
  assert.equal(ihdr.interlace, 0, "app icon must be non-interlaced");

  const pixels = decodeRgba8Pixels(ihdr.width, ihdr.height, idatChunks);
  const alphaAt = (x: number, y: number): number => pixels[(y * ihdr.width + x) * 4 + 3]!;

  const transparentSamples: ReadonlyArray<readonly [number, number, string]> = [
    [0, 0, "top-left corner"],
    [1023, 0, "top-right corner"],
    [0, 1023, "bottom-left corner"],
    [1023, 1023, "bottom-right corner"],
    [512, 40, "top safe margin"],
    [40, 512, "left safe margin"],
    [983, 512, "right safe margin"],
  ];
  for (const [x, y, label] of transparentSamples) {
    assert.equal(alphaAt(x, y), 0, `${label} (${x},${y}) must be fully transparent`);
  }

  for (let y = 0; y < 90; y += 1) {
    for (let x = 0; x < ihdr.width; x += 1) {
      if (alphaAt(x, y) !== 0) {
        assert.fail(`top safe band y < 90 must stay transparent; found non-zero alpha at (${x},${y})`);
      }
    }
  }

  let opaqueCenterPixels = 0;
  for (let y = 256; y < 768; y += 8) {
    for (let x = 256; x < 768; x += 8) {
      if (alphaAt(x, y) > 0) opaqueCenterPixels += 1;
    }
  }
  assert.ok(alphaAt(512, 512) > 0, "center pixel (512,512) must be non-transparent");
  assert.ok(opaqueCenterPixels > 0, "center subject region must contain non-transparent pixels");
});
