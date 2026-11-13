// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  // `npm ci` runs root postinstall, and explicit installers keep offline/cached recovery
  // self-healing for gui-launch's direct path.txt check.
  const skill = readFileSync(path.join(repoRoot, "skills/harness-download/SKILL.md"), "utf8");
  const installer = readFileSync(path.join(repoRoot, "scripts/install-source.sh"), "utf8");
  const psInstaller = readFileSync(path.join(repoRoot, "scripts/install-source.ps1"), "utf8");
  for (const [name, body] of [
    ["skills/harness-download/SKILL.md", skill],
    ["scripts/install-source.sh", installer],
  ]) {
    assert.match(body, /node node_modules\/electron\/install\.js/u, `${name} must run Electron's installer`);
  }
  assert.match(
    psInstaller,
    /node_modules\/electron\/install\.js/u,
    "scripts/install-source.ps1 must run Electron's installer",
  );
  assert.match(
    skill,
    /\$env:PATH\s*=\s*"\$HOME\\\.harness-anything\\npm-global;\$env:PATH"/u,
    "skills/harness-download/SKILL.md must keep the Windows npm prefix directly on PATH (without \\bin)",
  );
});

test("root postinstall installs Electron when present and stays safe under skip or omit=dev", () => {
  const rootPackage = readJson("package.json");
  const postinstall = rootPackage.scripts?.postinstall;
  assert.equal(typeof postinstall, "string", "package.json must declare scripts.postinstall");
  assert.match(postinstall, /node_modules\/electron\/install\.js/u);
  assert.match(postinstall, /ELECTRON_SKIP_BINARY_DOWNLOAD/u);

  const scratch = mkdtempSync(path.join(tmpdir(), "ha-root-postinstall-"));
  try {
    const clean = spawnSync(postinstall, { cwd: scratch, shell: true, encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stderr);

    const electronDir = path.join(scratch, "node_modules", "electron");
    const marker = path.join(scratch, "installed.txt");
    mkdirSync(electronDir, { recursive: true });
    writeFileSync(
      path.join(electronDir, "install.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok");\n`,
    );

    const skipped = spawnSync(postinstall, {
      cwd: scratch,
      shell: true,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
    });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.throws(() => readFileSync(marker, "utf8"), /ENOENT/u);

    const ran = spawnSync(postinstall, {
      cwd: scratch,
      shell: true,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "" },
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(readFileSync(marker, "utf8"), "ok");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
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
