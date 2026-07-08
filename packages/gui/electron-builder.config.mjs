const outputDir = process.env.HARNESS_GUI_BUILDER_OUTPUT ?? "../../dist/gui-local-mac-arm64";

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "dev.harness-anything.gui",
  productName: "Harness Anything",
  copyright: "Copyright © 2026 Harness Anything contributors",
  asar: false,
  npmRebuild: false,
  compression: "normal",
  forceCodeSigning: false,
  directories: {
    app: "../..",
    output: outputDir
  },
  extraMetadata: {
    name: "harness-anything-gui",
    version: "0.0.0",
    main: "packages/gui/src/main/electron-main.ts"
  },
  files: [
    "package.json",
    "packages/gui/package.json",
    "packages/gui/src/**/*",
    "packages/gui/dist/**/*",
    "packages/gui/dist-electron/**/*",
    "packages/daemon/src/**/*",
    "packages/kernel/src/**/*",
    "packages/cli/package.json",
    "packages/cli/dist/**/*",
    "!**/*.map",
    "!**/*.tsbuildinfo",
    "!**/node_modules/**/*"
  ],
  extraResources: [
    {
      from: "build-resources/node",
      to: "node",
      filter: ["**/*"]
    },
    {
      from: "build-resources/app-node_modules",
      to: "app/node_modules",
      filter: ["**/*"]
    }
  ],
  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] }
    ],
    category: "public.app-category.developer-tools",
    identity: null,
    artifactName: "Harness-Anything-GUI-${version}-mac-${arch}.${ext}"
  },
  win: {
    target: [
      { target: "nsis", arch: ["x64"] }
    ],
    signExecutable: false,
    artifactName: "Harness-Anything-GUI-Setup-${version}-win-${arch}.${ext}"
  },
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] }
    ],
    category: "Development",
    artifactName: "Harness-Anything-GUI-${version}-linux-${arch}.${ext}"
  }
};

export default config;
