// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Effect, Either, Exit } from "effect";
import {
  makeGithubCredentialResolver,
  makeFetchGithubTransport,
  makeGithubIssuesLifecycleEngine,
  type GithubCredentialResolver,
  type GithubHttpRequest,
  type GithubHttpResponse,
  type GithubSubprocessRunner,
  type GithubTransport,
  type GithubTransportError
} from "../src/index.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/github-api");
const fixedDate = new Date("2026-07-16T00:00:00.000Z");
const fakeCredential = "fixture-credential-value";

test("GitHub provider advertises readonly capabilities and no write surface", () => {
  const engine = makeGithubIssuesLifecycleEngine({ transport: queueTransport([]), credentialResolver: credentialResolver() });

  assert.deepEqual(Effect.runSync(engine.capabilities), {
    snapshots: true,
    listTasks: true,
    publishNote: false
  });
  for (const method of ["publishNote", "transition", "close", "reopen", "assign", "label", "comment"]) {
    assert.equal(method in engine, false, method);
  }
});

test("default transport uses injected fetch, selects safe response headers, and parses only success bodies", (_context, done) => {
  const calls: Array<{ readonly url: string; readonly method?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({ fixture: true }), {
      status: 200,
      headers: {
        Link: "<https://api.github.com/example?page=2>; rel=\"next\"",
        "X-Private-Fixture": "must-not-cross-boundary"
      }
    });
  };
  const transport = makeFetchGithubTransport({ fetch: fetchImpl, timeoutMs: 1000 });
  const effect = transport.request({
    method: "GET",
    url: "https://api.github.com/repos/acme/widgets/issues/1",
    headers: { Authorization: "Bearer fixture" }
  });
  Effect.runCallback(effect, {
    onExit: (exit) => {
      try {
        assert.equal(Exit.isSuccess(exit), true);
        if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
        assert.deepEqual(calls, [{ url: "https://api.github.com/repos/acme/widgets/issues/1", method: "GET" }]);
        assert.deepEqual(exit.value.body, { fixture: true });
        assert.equal(exit.value.headers.link?.includes("rel=\"next\""), true);
        assert.equal("x-private-fixture" in exit.value.headers, false);
        done();
      } catch (error) {
        done(error);
      }
    }
  });
});

test("credential resolver enforces GH_TOKEN, GITHUB_TOKEN, then fixed gh auth token precedence", () => {
  const calls: Array<{ readonly executable: string; readonly args: ReadonlyArray<string> }> = [];
  const subprocessRunner: GithubSubprocessRunner = {
    run: (executable, args) => {
      calls.push({ executable, args });
      return Effect.succeed("keychain-fixture");
    }
  };

  const gh = Effect.runSync(makeGithubCredentialResolver({
    env: { GH_TOKEN: "gh-fixture", GITHUB_TOKEN: "github-fixture" },
    subprocessRunner
  }).resolve());
  const github = Effect.runSync(makeGithubCredentialResolver({
    env: { GITHUB_TOKEN: "github-fixture" },
    subprocessRunner
  }).resolve());
  const keychain = Effect.runSync(makeGithubCredentialResolver({ env: {}, subprocessRunner }).resolve());

  assert.equal(gh.source, "env:GH_TOKEN");
  assert.equal(github.source, "env:GITHUB_TOKEN");
  assert.equal(keychain.source, "keychain:gh");
  assert.deepEqual(calls, [{ executable: "gh", args: ["auth", "token"] }]);
});

test("missing credentials return AuthMissing without calling transport", () => {
  let transportCalls = 0;
  const transport: GithubTransport = {
    request: () => {
      transportCalls += 1;
      return Effect.die("transport must not be called");
    }
  };
  const resolver: GithubCredentialResolver = {
    resolve: () => Effect.fail({ _tag: "AuthMissing", engine: "github" })
  };
  const engine = makeGithubIssuesLifecycleEngine({ transport, credentialResolver: resolver });
  const result = Effect.runSync(Effect.either(engine.snapshot({ engine: "github", ref: "acme/widgets#101" })));

  assert.equal(Either.isLeft(result), true);
  if (Either.isLeft(result)) assert.deepEqual(result.left, { _tag: "AuthMissing", engine: "github" });
  assert.equal(transportCalls, 0);
});

test("snapshot sends one authenticated GET and returns a fresh normalized projection", () => {
  const requests: GithubHttpRequest[] = [];
  const fixture = readResponse("open-active.json");
  const engine = makeGithubIssuesLifecycleEngine({
    transport: queueTransport([fixture.response], requests),
    credentialResolver: credentialResolver(),
    clock: () => fixedDate
  });
  const snapshot = Effect.runSync(engine.snapshot({ engine: "github", ref: "https://github.com/Acme/Widgets/issues/102" }));

  assert.equal(snapshot.ref, "acme/widgets#102");
  assert.equal(snapshot.canonicalStatus, "active");
  assert.equal(snapshot.assignee, "fixture-assignee");
  assert.equal(snapshot.freshness, "fresh");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.url, "https://api.github.com/repos/acme/widgets/issues/102");
  assert.equal(requests[0]?.headers.Authorization, `Bearer ${fakeCredential}`);
  assert.equal(requests[0]?.headers.Accept, "application/vnd.github+json");
  assert.equal(requests[0]?.headers["X-GitHub-Api-Version"], "2022-11-28");
});

test("snapshot rejects Pull Request markers and malformed fields with typed errors", () => {
  for (const [name, ref, expected] of [
    ["pull-request.json", "acme/widgets#110", "RefNotFound"],
    ["malformed.json", "acme/widgets#111", "MalformedSnapshot"]
  ] as const) {
    const fixture = readResponse(name);
    const engine = makeGithubIssuesLifecycleEngine({
      transport: queueTransport([fixture.response]),
      credentialResolver: credentialResolver()
    });
    const result = Effect.runSync(Effect.either(engine.snapshot({ engine: "github", ref })));
    assert.equal(Either.isLeft(result), true, name);
    if (Either.isLeft(result)) assert.equal(result.left._tag, expected, name);
  }
});

test("HTTP errors are typed and never retain response or credential data", () => {
  const fixture = readErrorMatrix();
  for (const entry of fixture.cases) {
    const engine = makeGithubIssuesLifecycleEngine({
      transport: queueTransport([entry.response]),
      credentialResolver: credentialResolver()
    });
    const result = Effect.runSync(Effect.either(engine.snapshot({ engine: "github", ref: "acme/widgets#101" })));
    assert.equal(Either.isLeft(result), true, entry.name);
    if (!Either.isLeft(result)) continue;
    assert.equal(result.left._tag, entry.expectedError, entry.name);
    const serialized = JSON.stringify(result.left);
    assert.equal(serialized.includes("private body"), false);
    assert.equal(serialized.includes(fakeCredential), false);
  }
});

test("network and timeout failures map to sanitized EngineError values", () => {
  for (const [transportError, expected] of [
    [{ _tag: "GithubNetworkFailure" }, "EngineUnreachable"],
    [{ _tag: "GithubTransportTimeout", ms: 3210 }, "Timeout"]
  ] as const) {
    const transport: GithubTransport = { request: () => Effect.fail(transportError) };
    const engine = makeGithubIssuesLifecycleEngine({ transport, credentialResolver: credentialResolver() });
    const result = Effect.runSync(Effect.either(engine.snapshot({ engine: "github", ref: "acme/widgets#101" })));
    assert.equal(Either.isLeft(result), true);
    if (Either.isLeft(result)) assert.equal(result.left._tag, expected);
  }
});

test("repo list follows sanitized pagination, skips Pull Requests, and filters raw status", () => {
  const requests: GithubHttpRequest[] = [];
  const pageOne = readResponse("list-page-1.json");
  const pageTwo = readResponse("list-page-2.json");
  const engine = makeGithubIssuesLifecycleEngine({
    transport: queueTransport([pageOne.response, pageTwo.response], requests),
    credentialResolver: credentialResolver(),
    clock: () => fixedDate
  });
  const snapshots = Effect.runSync(engine.listTasks({
    engine: "github",
    repository: "Acme/Widgets",
    rawStatus: "closed:completed",
    label: "fixture-label"
  }));

  assert.deepEqual(snapshots.map((snapshot) => snapshot.ref), ["acme/widgets#203"]);
  assert.equal(snapshots[0]?.canonicalStatus, "done");
  assert.equal(requests.length, 2);
  assert.match(requests[0]?.url ?? "", /state=closed/u);
  assert.match(requests[0]?.url ?? "", /labels=fixture-label/u);
  assert.match(requests[1]?.url ?? "", /page=2/u);
  assert.equal(requests.some((request) => request.url.includes("repositories/1")), false);
});

function credentialResolver(): GithubCredentialResolver {
  return {
    resolve: () => Effect.succeed({ token: fakeCredential, source: "env:GH_TOKEN" })
  };
}

function queueTransport(
  responses: ReadonlyArray<GithubHttpResponse>,
  requests: GithubHttpRequest[] = []
): GithubTransport {
  let index = 0;
  return {
    request: (request) => {
      requests.push(request);
      const response = responses[index];
      index += 1;
      return response
        ? Effect.succeed(response)
        : Effect.fail({ _tag: "GithubNetworkFailure" } satisfies GithubTransportError);
    }
  };
}

function readResponse(name: string): { readonly response: GithubHttpResponse } {
  return JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));
}

function readErrorMatrix(): {
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly response: GithubHttpResponse;
    readonly expectedError: string;
  }>;
} {
  return JSON.parse(readFileSync(path.join(fixtures, "errors.json"), "utf8"));
}
