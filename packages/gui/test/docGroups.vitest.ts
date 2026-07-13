import { describe, expect, it } from "vitest";
import { inferDocGroup, isRequiredDocGroup } from "../src/renderer/model/docGroups.ts";
import type { DocGroup } from "../src/renderer/model/types.ts";

describe("document group semantics", () => {
  it.each([
    ["INDEX.md", "required"],
    ["contract.md", "required"],
    ["plan/roadmap.md", "plan"],
    ["design/architecture.md", "design"],
    ["progress.md", "progress"],
    ["artifacts/verification.md", "closeout"],
    ["evidence/facts.md", "evidence"],
    ["notes.md", "progress"],
  ] satisfies Array<[string, DocGroup]>)('classifies "%s" as %s', (path, expected) => {
    expect(inferDocGroup(path)).toBe(expected);
  });

  it("preserves the required-document behavior after semantic-key migration", () => {
    const groups: DocGroup[] = ["required", "plan", "design", "progress", "closeout", "evidence"];
    expect(groups.filter(isRequiredDocGroup)).toEqual(["required", "closeout"]);
  });
});
