// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));

test("allowScripts does not claim to cover an Electron install script that does not exist", () => {
  // Electron 42 removed its postinstall from package.json; npm's install-scripts walk does
  // not list it, so an allowScripts entry would be dead policy and would hide the real
  // requirement: the source install must run electron's own install.js explicitly.
  const rootPackage = readJson("package.json");
  const lockfile = readJson("package-lock.json");
  const electron = lockfile.packages?.["node_modules/electron"];

  assert.equal(typeof electron?.version, "string", "package-lock.json must resolve electron");
  assert.equal(
    electron.hasInstallScript,
    undefined,
    "Electron must stay script-free while it has no lifecycle install",
  );
  assert.equal(
    Object.keys(rootPackage.allowScripts ?? {}).some((entry) => entry.startsWith("electron@")),
    false,
    "allowScripts must not advertise a script Electron does not ship",
  );
});

test("source install runs Electron's own installer before building the GUI", () => {
  // `npm ci` leaves node_modules/electron/dist absent for Electron 42. `require("electron")`
  // would download lazily, but gui-launch reads path.txt directly, so the explicit installer
  // is the step that makes `ha gui` work after a source install.
  const skill = readFileSync(path.join(repoRoot, "skills/harness-download/SKILL.md"), "utf8");
  const installer = readFileSync(path.join(repoRoot, "scripts/install-source.sh"), "utf8");
  for (const [name, body] of [
    ["skills/harness-download/SKILL.md", skill],
    ["scripts/install-source.sh", installer],
  ]) {
    assert.match(body, /node node_modules\/electron\/install\.js/u, `${name} must run Electron's installer`);
  }
});

test("optional msgpackr-extract native acceleration stays out of allowScripts", () => {
  // msgpackr works without the addon; the platform prebuild ships as an optional
  // dependency (node_modules/@msgpackr-extract/msgpackr-extract-<platform>), so its
  // install script only runs a download that the optional package already satisfies.
  // Granting it would add an install-time code path with no functional gain.
  const rootPackage = readJson("package.json");
  assert.equal(
    Object.keys(rootPackage.allowScripts ?? {}).some((entry) => entry.startsWith("msgpackr-extract")),
    false,
    "msgpackr-extract is optional native acceleration and must not be allowlisted",
  );
});
