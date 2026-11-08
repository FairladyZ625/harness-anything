import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import * as fs from "node:fs";
import path from "node:path";

// Positive control (review F1): readiness derived from locally read bytes is refused whatever words
// it answers with. A heading probe and a readiness-named verdict are each a local judgment.
export function documentReadiness(authoredRoot: string): "complete" | "incomplete" {
  return readFileSync(path.join(authoredRoot, "tasks/example/task_plan.md"), "utf8").includes("## Goal")
    ? "complete"
    : "incomplete";
}

export function scaffoldState(authoredRoot: string): "authored" | "empty" {
  return readFileSync(path.join(authoredRoot, "tasks/example/task_plan.md"), "utf8").trim().length > 0
    ? "authored"
    : "empty";
}

// Positive control (review F1): an ordinary helper name and custom answer words still derive a
// readiness verdict from the bytes it read. The gate must not depend on `ready` appearing in names.
export function evaluate(authoredRoot: string): "complete" | "incomplete" {
  const body = readFileSync(path.join(authoredRoot, "tasks/example/task_plan.md"), "utf8");
  return body.trim().length > 0 ? "complete" : "incomplete";
}

// Boolean and aliased-string verdicts are also covered by the same IO boundary.
export function ordinaryBoolean(authoredRoot: string): boolean {
  const body = readFileSync(path.join(authoredRoot, "tasks/example/task_plan.md"), "utf8");
  return body.length > 0;
}

export function aliasedVerdict(authoredRoot: string): "complete" | "incomplete" {
  const bytes = readFileSync(path.join(authoredRoot, "tasks/example/task_plan.md"), "utf8");
  const verdict = bytes.trim().length > 0 ? "complete" : "incomplete";
  return verdict;
}

// The IO boundary covers promise-based filesystem reads as well as sync reads.
export async function promiseBoolean(authoredRoot: string): Promise<boolean> {
  const body = await readFileAsync(path.join(authoredRoot, "tasks/example/task_plan.md"), "utf8");
  return body.trim().length > 0;
}

export async function namespaceBoolean(authoredRoot: string): Promise<boolean> {
  const body = await fs.promises.readFile(path.join(authoredRoot, "tasks/example/task_plan.md"), "utf8");
  return body.length > 0;
}

// Path provenance also follows authored directories handed to a file-list helper. The IO call
// remains the violation even when the helper, rather than the caller, supplies each filename.
export function listedFileRead(authoredRoot: string): readonly string[] {
  const eventsRoot = path.join(authoredRoot, "events");
  return listJsonFiles(eventsRoot).map((file: string) => readFileSync(file, "utf8"));
}
