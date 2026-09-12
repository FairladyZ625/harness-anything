export const publicReadyPackages = Object.freeze([
  Object.freeze({
    packagePath: "packages/cli/package.json",
    packageName: "@harness-anything/cli",
    version: "0.0.1",
    repositoryDirectory: "packages/cli",
    bins: Object.freeze({
      "harness-anything": "dist/cli/src/index.js",
      ha: "dist/cli/src/index.js",
    }),
    required: true,
  }),
  Object.freeze({
    packagePath: "packages/daemon/package.json",
    packageName: "@harness-anything/daemon",
    version: "0.0.1",
    repositoryDirectory: "packages/daemon",
    bins: Object.freeze({ "harness-anything-daemon": "dist/index.js" }),
    required: false,
  }),
]);

export const publicReadyPackagesByPath = new Map(publicReadyPackages.map((entry) => [entry.packagePath, entry]));
