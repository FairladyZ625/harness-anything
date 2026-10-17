// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import config from "../electron-builder.config.mjs";

const readPackage = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("desktop app metadata uses the published CLI package version", () => {
  const cliPackage = readPackage("../../cli/package.json");

  assert.equal(config.extraMetadata.version, cliPackage.version);
});

test("macOS packaging requires hardened runtime signing and notarization", () => {
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.match(config.mac.entitlements, /entitlements\.mac\.plist$/u);
  assert.match(config.mac.entitlementsInherit, /entitlements\.mac\.inherit\.plist$/u);
  assert.equal("identity" in config.mac, false);
});
