export const publicReadyPackages = Object.freeze([
  Object.freeze({
    packagePath: "packages/kernel/package.json",
    packageName: "@harness-anything/kernel",
    version: "0.0.1",
    repositoryDirectory: "packages/kernel",
    bins: Object.freeze({}),
    required: false,
  }),
  Object.freeze({
    packagePath: "packages/application/package.json",
    packageName: "@harness-anything/application",
    version: "0.0.1",
    repositoryDirectory: "packages/application",
    bins: Object.freeze({}),
    required: false,
  }),
  Object.freeze({
    packagePath: "packages/preset/package.json",
    packageName: "@harness-anything/preset",
    version: "0.0.1",
    repositoryDirectory: "packages/preset",
    bins: Object.freeze({}),
    required: false,
  }),
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
  // GUI re-enters the approved npm publish set per dec_A36285F75C28B6BBA041F281CA CH1
  // (npm is the distribution channel while the .app path is deferred); the same entry
  // was removed by PR #2948 under the since-overturned .app-only assumption.
  Object.freeze({
    packagePath: "packages/gui/package.json",
    packageName: "@harness-anything/gui",
    version: "0.0.1",
    repositoryDirectory: "packages/gui",
    bins: Object.freeze({}),
    required: false,
  }),
]);

export const publicReadyPackagesByPath = new Map(publicReadyPackages.map((entry) => [entry.packagePath, entry]));
