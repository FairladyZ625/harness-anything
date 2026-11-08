import { readFileSync } from "node:fs";

// Positive control (review F1): readiness derived from locally read bytes is refused whatever words
// it answers with. A heading probe and a readiness-named verdict are each a local judgment.
export function documentReadiness(file: string): "complete" | "incomplete" {
  return readFileSync(file, "utf8").includes("## Goal") ? "complete" : "incomplete";
}

export function scaffoldState(file: string): "authored" | "empty" {
  return readFileSync(file, "utf8").trim().length > 0 ? "authored" : "empty";
}

// Positive control (review F1): an ordinary helper name and custom answer words still derive a
// readiness verdict from the bytes it read. The gate must not depend on `ready` appearing in names.
export function evaluate(file: string): "complete" | "incomplete" {
  const body = readFileSync(file, "utf8");
  return body.trim().length > 0 ? "complete" : "incomplete";
}
