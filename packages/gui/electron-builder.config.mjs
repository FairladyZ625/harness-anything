/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "dev.harness-anything.gui",
  productName: "Harness Anything",
  copyright: "Copyright © 2026 Harness Anything contributors",
  asar: false,
  npmRebuild: false,
  compression: "normal",
  directories: {
    app: "../..",
    output: "../../dist/gui-local-mac-arm64"
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
  artifactName: "Harness-Anything-GUI-${version}-mac-${arch}.${ext}",
  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] }
    ],
    category: "public.app-category.developer-tools",
    identity: null
  }
};

export default config;
