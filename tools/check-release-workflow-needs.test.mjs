// harness-test-tier: contract
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");

function parseJobs(text) {
  const jobs = new Map();
  const lines = text.split(/\r?\n/u);
  let current = null;
  for (const line of lines) {
    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (jobMatch) {
      current = { needs: new Set(), outputRefs: new Set() };
      jobs.set(jobMatch[1], current);
      continue;
    }
    if (!current) continue;
    const needsMatch = /^    needs:\s*(.+?)\s*$/u.exec(line);
    if (needsMatch) {
      const value = needsMatch[1];
      if (value.startsWith("[")) {
        for (const dependency of value.slice(1, -1).split(",")) {
          if (dependency.trim()) current.needs.add(dependency.trim());
        }
      } else {
        current.needs.add(value);
      }
    }
    for (const match of line.matchAll(/needs\.([A-Za-z0-9_-]+)\.outputs\./gu)) current.outputRefs.add(match[1]);
  }
  return jobs;
}

test("release jobs directly need every job whose outputs they read", () => {
  for (const [jobId, job] of parseJobs(workflow)) {
    assert.deepEqual(
      [...job.outputRefs].filter((dependency) => !job.needs.has(dependency)),
      [],
      `${jobId} reads outputs from a job outside its direct needs`,
    );
  }
});
