import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { entryJoinedValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.allowFailure ? "pipe" : "inherit"]
  });
}

function gitStatus(args) {
  const result = execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result;
}

const violations = [];

function record(message) {
  violations.push(message);
}

const topLevel = normalizePath(git(["rev-parse", "--show-toplevel"]).trim());
const cwd = normalizePath(process.cwd());
if (topLevel !== cwd) {
  record(`run from repository root: expected ${topLevel}, got ${process.cwd()}`);
}

for (const privateRoot of [".harness-private", "harness", ".harness"]) {
  try {
    // Probe a phantom child path: works even when the private root does not
    // exist on disk (CI clean checkout), while still failing if the ignore
    // rule is missing from .gitignore.
    gitStatus(["check-ignore", "--no-index", "-q", `${privateRoot}/__boundary_probe__`]);
  } catch {
    record(`${privateRoot} is not ignored by git`);
  }
}

const explicitlyForbidden = git(["ls-files", "--", ".harness-private", "harness", ".harness", "AGENTS.md"])
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

for (const trackedPath of explicitlyForbidden) {
  record(`forbidden tracked path: ${trackedPath}`);
}

const allTracked = git(["ls-files", "-z"])
  .split("\0")
  .filter(Boolean);
const allowlist = loadGateAllowlist("check-private-boundary", {
  requiredSections: ["privateContentMarkers"]
});
const privateContentMarkers = entryJoinedValues(allowlist.privateContentMarkers);

const sessionBranches = git(["branch", "--list", "sessions/*"])
  .trim()
  .split(/\r?\n/u)
  .map((entry) => entry.replace(/^\*\s*/u, "").trim())
  .filter(Boolean);

for (const branch of sessionBranches) {
  record(`forbidden session branch in public repo: ${branch}`);
}

for (const trackedPath of allTracked) {
  if (
    trackedPath === "AGENTS.md" ||
    trackedPath === ".harness-private" ||
    trackedPath.startsWith(".harness-private/") ||
    trackedPath === "harness" ||
    trackedPath.startsWith("harness/") ||
    trackedPath === ".harness" ||
    trackedPath.startsWith(".harness/") ||
    trackedPath.startsWith(".codex/attachments/")
  ) {
    record(`private path tracked in public repo: ${trackedPath}`);
  }

  try {
    const text = readFileSync(trackedPath, "utf8");
    for (const marker of privateContentMarkers) {
      if (text.includes(marker)) {
        record(`private content marker "${marker}" found in ${trackedPath}`);
      }
    }
  } catch {
    // Binary files are not scanned for text markers.
  }
}

if (violations.length > 0) {
  console.error("Private boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Private boundary check passed.");

function normalizePath(value) {
  return path.resolve(value).split(path.sep).join("/");
}
