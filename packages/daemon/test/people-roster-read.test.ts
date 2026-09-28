// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPeopleRosterIfPresent } from "../src/identity/people-roster.ts";

// A coarse filesystem clock leaves a file's mtime unchanged for a rewrite within the same tick;
// pinning it to one whole second reproduces that on any filesystem.
const tick = 1_756_000_000;

function withAuthoredRoot(fn: (rootDir: string, authoredRoot: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-people-roster-read-")),
    authoredRoot = path.join(rootDir, "harness");
  mkdirSync(authoredRoot, { recursive: true });
  try {
    fn(rootDir, authoredRoot);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writePinned(filePath: string, body: string): void {
  writeFileSync(filePath, body, "utf8");
  utimesSync(filePath, tick, tick);
}

test("the people roster reflects a people.yaml rewrite within the same mtime tick", () => {
  withAuthoredRoot((rootDir, authoredRoot) => {
    writeFileSync(path.join(authoredRoot, "harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
    const rosterPath = path.join(authoredRoot, "people.yaml"),
      roster = (displayName: string) =>
        `schema: harness-people/v1\npeople:\n  - personId: person_a\n    displayName: "${displayName}"\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:test\n        subject: 501\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`;
    writePinned(rosterPath, roster("First"));
    assert.equal(loadPeopleRosterIfPresent(rootDir)?.people[0]?.displayName, "First");
    writePinned(rosterPath, roster("Other"));
    assert.equal(loadPeopleRosterIfPresent(rootDir)?.people[0]?.displayName, "Other");
  });
});
