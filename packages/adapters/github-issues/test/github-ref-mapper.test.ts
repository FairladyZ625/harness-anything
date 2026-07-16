// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  decodeGithubIssue,
  isEngineError,
  mapGithubIssue,
  mapGithubStatus,
  parseGithubIssueRef,
  parseGithubRepositoryRef,
  type GithubHttpResponse,
  type GithubRawIssue
} from "../src/index.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/github-api");
const fixedDate = new Date("2026-07-16T00:00:00.000Z");

test("GitHub issue refs normalize shorthand and standard issue URLs", () => {
  const shorthand = parseGithubIssueRef("Acme/Widgets#00101");
  const url = parseGithubIssueRef("https://github.com/Acme/Widgets/issues/101?notification_referrer_id=fixture");
  const repository = parseGithubRepositoryRef("Acme/Widgets");

  assert.equal(isEngineError(shorthand), false);
  assert.equal(isEngineError(url), false);
  assert.equal(isEngineError(repository), false);
  if (!isEngineError(shorthand)) assert.equal(shorthand.normalized, "acme/widgets#101");
  if (!isEngineError(url)) assert.equal(url.normalized, "acme/widgets#101");
  if (!isEngineError(repository)) assert.equal(repository.normalized, "acme/widgets");
});

test("GitHub ref parser rejects pull URLs, non-GitHub hosts, and invalid numbers", () => {
  for (const ref of [
    "https://github.com/acme/widgets/pull/1",
    "https://example.invalid/acme/widgets/issues/1",
    "acme/widgets#0",
    "-invalid/widgets#1",
    "acme/widgets#not-a-number"
  ]) {
    const parsed = parseGithubIssueRef(ref);
    assert.equal(isEngineError(parsed), true, ref);
    if (isEngineError(parsed)) assert.equal(parsed._tag, "RefNotFound");
  }
});

test("fixture mapping covers the closed deterministic layer and open heuristic layer", () => {
  const names = [
    "open-planned.json",
    "open-active.json",
    "open-blocked.json",
    "open-in-review.json",
    "open-unknown-label.json",
    "closed-completed.json",
    "closed-not-planned.json",
    "closed-null-reason.json",
    "closed-unmapped-reason.json"
  ];

  for (const name of names) {
    const fixture = readProjectionFixture(name);
    const decoded = decodeGithubIssue(fixture.response.body);
    assert.equal(decoded.kind, "issue", name);
    if (decoded.kind !== "issue") continue;
    const snapshot = mapGithubIssue(decoded.issue, { ref: fixture.expected.ref, fetchedAt: fixedDate });
    for (const [key, value] of Object.entries(fixture.expected)) {
      assert.deepEqual(snapshot[key as keyof typeof snapshot], value, `${name}:${key}`);
    }
    assert.equal(snapshot.freshness, "fresh");
    assert.equal(snapshot.source, "external-engine");
    assert.equal(snapshot.engine, "github");
    assert.equal(snapshot.fetchedAt, fixedDate.toISOString());
  }
});

test("closed mapping wins over open labels and open heuristics never create terminal states", () => {
  const closed = rawIssue({ state: "closed", stateReason: "completed", labels: ["blocked"] });
  const open = rawIssue({ state: "open", stateReason: null, labels: ["done"], assignee: null });
  const onHold = rawIssue({ state: "open", stateReason: null, labels: ["on hold"], assignee: null });

  assert.equal(mapGithubStatus(closed).canonicalStatus, "done");
  assert.equal(mapGithubStatus(open).canonicalStatus, "planned");
  assert.equal(mapGithubStatus(onHold).canonicalStatus, "blocked");
});

test("label override replaces defaults and remains limited to non-terminal states", () => {
  const blocked = rawIssue({ state: "open", stateReason: null, labels: ["waiting-upstream"] });
  const defaultLabel = rawIssue({ state: "open", stateReason: null, labels: ["blocked"] });
  const options = { blocked: ["waiting-upstream"], active: ["implementation"] } as const;

  assert.equal(mapGithubStatus(blocked, options).canonicalStatus, "blocked");
  assert.equal(mapGithubStatus(defaultLabel, options).canonicalStatus, "planned");
  assert.equal(mapGithubStatus(rawIssue({ state: "open", stateReason: null, labels: ["implementation"] }), options).canonicalStatus, "active");
});

test("malformed response returns only a field descriptor", () => {
  const fixture = readErrorFixture("malformed.json");
  const decoded = decodeGithubIssue(fixture.response.body);

  assert.equal(decoded.kind, "error");
  if (decoded.kind === "error") {
    assert.deepEqual(decoded.error, { _tag: "MalformedSnapshot", raw: "github_issue_invalid:label_name" });
  }
});

function readProjectionFixture(name: string): {
  readonly response: GithubHttpResponse;
  readonly expected: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));
}

function readErrorFixture(name: string): {
  readonly response: GithubHttpResponse;
  readonly expectedError: string;
} {
  return JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));
}

function rawIssue(overrides: Partial<GithubRawIssue>): GithubRawIssue {
  return {
    number: 1,
    title: "Fixture",
    state: "open",
    stateReason: null,
    htmlUrl: "https://github.com/acme/widgets/issues/1",
    assignee: null,
    labels: [],
    ...overrides
  };
}
