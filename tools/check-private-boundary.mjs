import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

const topLevel = git(["rev-parse", "--show-toplevel"]).trim();
if (topLevel !== process.cwd()) {
  record(`run from repository root: expected ${topLevel}, got ${process.cwd()}`);
}

try {
  gitStatus(["check-ignore", "-q", ".harness-private"]);
} catch {
  record(".harness-private is not ignored by git");
}

const explicitlyForbidden = git(["ls-files", "--", ".harness-private", "AGENTS.md"])
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

for (const trackedPath of explicitlyForbidden) {
  record(`forbidden tracked path: ${trackedPath}`);
}

const allTracked = git(["ls-files", "-z"])
  .split("\0")
  .filter(Boolean);
const privateContentMarkers = [
  "/Users/lizeyu/",
  "Harness重设计",
  "kernel-rewrite-2026-06-final"
];

for (const trackedPath of allTracked) {
  if (
    trackedPath === "AGENTS.md" ||
    trackedPath === ".harness-private" ||
    trackedPath.startsWith(".harness-private/") ||
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
