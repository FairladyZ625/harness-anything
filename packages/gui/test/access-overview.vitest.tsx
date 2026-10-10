// harness-test-tier: fast
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { grantsByPerson } from "../src/renderer/access-model.ts";

describe("members overview", () => {
  const people = [
    { personId: "alice", username: "Alice" },
    { personId: "bob", username: "Bob" },
  ];
  const grants = [
    { personId: "alice", groupId: "viewer", resource: "repo-a" },
    { personId: "alice", groupId: "admin", resource: "repo-b" },
    { personId: "alice", groupId: "contributor", resource: "repo-a:task/one" },
    { personId: "bob", groupId: "viewer", resource: "@fleet" },
  ];
  it("gathers all scopes under one row per account", () => {
    const rows = grantsByPerson(people, grants);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.grants).toEqual(grants.slice(0, 3));
    expect(rows[1]!.grants).toEqual(grants.slice(3));
  });
  it("repository view keeps its object grants and fleet grants visible", () => {
    const rows = grantsByPerson(people, grants, "repo-a");
    expect(rows[0]!.grants.map((grant) => grant.resource)).toEqual(["repo-a", "repo-a:task/one"]);
    expect(rows[1]!.grants[0]!.resource).toBe("@fleet");
    expect(grantsByPerson(people, grants, "repo-c")[0]!.grants).toEqual([]);
  });
});
