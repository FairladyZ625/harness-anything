import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const outputDir = process.env.HARNESS_GUI_BUILDER_OUTPUT ?? "../../dist/gui-local-mac-arm64";
const cliPackage = JSON.parse(readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"));
const entitlementsPath = resolve(dirname(fileURLToPath(import.meta.url)), "build-resources/entitlements.mac.plist");
const entitlementsInheritPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "build-resources/entitlements.mac.inherit.plist",
);
const machOFileMagics = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

function ignoreNonMachOCode(filePath) {
  if (filePath.endsWith(".app") || filePath.endsWith(".framework")) {
    return false;
  }

  const fileDescriptor = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(8);
    if (readSync(fileDescriptor, header, 0, header.length, 0) !== header.length) {
      return true;
    }

    const magic = header.readUInt32BE(0);
    if (magic === 0xcafebabe || magic === 0xcafebabf || magic === 0xbebafeca || magic === 0xbfbafeca) {
      // FAT_MAGIC overlaps Java class files; a Mach-O fat header has fewer than 30 slices.
      const architectureCount =
        magic === 0xbebafeca || magic === 0xbfbafeca ? header.readUInt32LE(4) : header.readUInt32BE(4);
      return architectureCount === 0 || architectureCount > 30;
    }

    return !machOFileMagics.has(magic);
  } finally {
    closeSync(fileDescriptor);
  }
}

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "dev.harness-anything.gui",
  productName: "Harness Anything",
  copyright: "Copyright © 2026 Harness Anything contributors",
  asar: false,
  nativeModules: { npmRebuild: false },
  compression: "normal",
  directories: {
    app: "../..",
    output: outputDir,
  },
  extraMetadata: {
    name: "harness-anything-gui",
    version: cliPackage.version,
    main: "packages/gui/dist-electron/electron-main.js",
  },
  publish: {
    provider: "generic",
    url: "https://harness-update.qianbaner.top/${channel}/",
  },
  files: [
    "package.json",
    "packages/gui/package.json",
    "packages/gui/icons/**/*",
    "packages/gui/dist/**/*",
    "packages/gui/dist-electron/**/*",
    "packages/cli/package.json",
    "packages/cli/dist/**/*",
    "!**/*.map",
    "!**/*.tsbuildinfo",
    "!**/node_modules/**/*",
  ],
  extraResources: [
    {
      from: "build-resources/node",
      to: "node",
      filter: ["**/*"],
    },
    {
      from: "build-resources/app-node_modules",
      to: "app/node_modules",
      filter: ["**/*"],
    },
  ],
  mac: {
    // Per-platform: Windows keeps `sign: false`, which a top-level force would reject.
    forceCodeSigning: true,
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    category: "public.app-category.developer-tools",
    sign: {
      hardenedRuntime: true,
      entitlements: entitlementsPath,
      entitlementsInherit: entitlementsInheritPath,
      ignore: ignoreNonMachOCode,
    },
    notarize: true,
    artifactName: "Harness-Anything-${version}-${arch}.${ext}",
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    sign: false,
    artifactName: "Harness-Anything-GUI-Setup-${version}-win-${arch}.${ext}",
  },
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    category: "Development",
    artifactName: "Harness-Anything-GUI-${version}-linux-${arch}.${ext}",
  },
};

export default config;
