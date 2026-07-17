// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect, Either } from "effect";
import {
  createGithubIssuesReadProvider,
  type GithubCredentialResolver,
  type GithubHttpRequest,
  type GithubHttpResponse,
  type GithubIssuesProviderOptions,
  type GithubTransport,
  type GithubTransportError
} from "../../src/composition/adapter-registry.ts";
import { parseArgs } from "../../src/cli/parse-args.ts";
import { toCliError } from "../../src/cli/error-mapper.ts";
import { toCommandReceipt } from "../../src/cli/receipt.ts";
import type { CliResult, ParsedCommand } from "../../src/cli/types.ts";
import {
  runGithubIssuesReadAction,
  type GithubIssuesReadAction,
  type GithubIssuesReadDependencies
} from "../../src/commands/github-issues.ts";

const adapterFixtures = path.resolve("packages/adapters/github-issues/test/fixtures/github-api");
const fixedDate = new Date("2026-07-16T00:00:00.000Z");
const fakeCredential = "cli-fixture-credential";

test("CLI parser and read runner accept shorthand and issue URL refs with JSON receipts", () => {
  withTempRoot((rootDir) => {
    for (const ref of ["Acme/Widgets#101", "https://github.com/Acme/Widgets/issues/101"]) {
      const requests: GithubHttpRequest[] = [];
      const receipt = execute(rootDir, ["snapshot", "github", ref, "--json"], dependencies({
        responses: [readResponse("open-planned.json").response],
        requests
      }));

      assert.equal(receipt.ok, true);
      assert.equal(receipt.command, "snapshot github");
      assert.equal(receipt.details?.report?.schema, "github-issue-snapshot-report/v1");
      assert.equal(receipt.details?.report?.snapshot?.ref, "acme/widgets#101");
      assert.equal(receipt.details?.report?.snapshot?.canonicalStatus, "planned");
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.method, "GET");
      assert.equal(JSON.stringify(receipt).includes(fakeCredential), false);
    }
    assert.deepEqual(readdirSync(rootDir), []);
  });
});

test("CLI list command returns repo-scoped paginated projections and no authored files", () => {
  withTempRoot((rootDir) => {
    const legacy = execute(rootDir, [
      "list", "github", "Acme/Widgets", "--raw-status", "closed:completed", "--label", "fixture-label", "--json"
    ], dependencies({
      responses: [readResponse("list-page-1.json").response, readResponse("list-page-2.json").response]
    }));
    const requests: GithubHttpRequest[] = [];
    const receipt = execute(rootDir, [
      "external",
      "list",
      "github",
      "Acme/Widgets",
      "--raw-status",
      "closed:completed",
      "--label",
      "fixture-label",
      "--json"
    ], dependencies({
      responses: [
        readResponse("list-page-1.json").response,
        readResponse("list-page-2.json").response
      ],
      requests
    }));

    assert.deepEqual(
      { ...receipt, meta: { ...receipt.meta, generatedAt: legacy.meta.generatedAt } },
      legacy
    );
    assert.equal(receipt.ok, true);
    assert.equal(receipt.command, "list github");
    assert.equal(receipt.rows, 1);
    assert.deepEqual(receipt.details?.report?.snapshots?.map((snapshot: { readonly ref: string }) => snapshot.ref), ["acme/widgets#203"]);
    assert.equal(requests.length, 2);
    assert.deepEqual(readdirSync(rootDir), []);
  });
});

test("CLI maps 401, 403, 404, and rate limit responses without private response data", () => {
  withTempRoot((rootDir) => {
    const matrix = readErrorMatrix();
    const expectedCodes = {
      unauthorized: "AuthMissing",
      forbidden: "AuthMissing",
      "not-found": "RefNotFound",
      "rate-limit": "RateLimited"
    } as const;

    for (const entry of matrix.cases) {
      const receipt = execute(rootDir, ["snapshot", "github", "acme/widgets#101", "--json"], dependencies({
        responses: [entry.response]
      }));
      assert.equal(receipt.ok, false, entry.name);
      assert.equal(receipt.error?.code, expectedCodes[entry.name as keyof typeof expectedCodes], entry.name);
      assert.equal(JSON.stringify(receipt).includes("private body"), false);
      assert.equal(JSON.stringify(receipt).includes(fakeCredential), false);
    }
  });
});

test("CLI maps injected network and timeout failures to stable typed codes", () => {
  withTempRoot((rootDir) => {
    for (const [transportError, code] of [
      [{ _tag: "GithubNetworkFailure" }, "EngineUnreachable"],
      [{ _tag: "GithubTransportTimeout", ms: 2500 }, "Timeout"]
    ] as const) {
      const receipt = execute(rootDir, ["snapshot", "github", "acme/widgets#101", "--json"], dependencies({ transportError }));
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error?.code, code);
    }
  });
});

test("CLI missing credential is AuthMissing and makes zero transport calls", () => {
  withTempRoot((rootDir) => {
    const requests: GithubHttpRequest[] = [];
    const resolver: GithubCredentialResolver = {
      resolve: () => Effect.fail({ _tag: "AuthMissing", engine: "github" })
    };
    const legacy = execute(rootDir, ["snapshot", "github", "acme/widgets#101", "--json"], dependencies({
      responses: [readResponse("open-planned.json").response],
      requests,
      credentialResolver: resolver
    }));
    const receipt = execute(rootDir, ["external", "snapshot", "github", "acme/widgets#101", "--json"], dependencies({
      responses: [readResponse("open-planned.json").response],
      requests,
      credentialResolver: resolver
    }));

    const stripGeneratedAt = (value: typeof receipt) => ({ ...value, meta: { ...value.meta, generatedAt: "normalized" } });
    assert.deepEqual(stripGeneratedAt(receipt), stripGeneratedAt(legacy));
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error?.code, "AuthMissing");
    assert.equal(requests.length, 0);
  });
});

test("CLI rejects Pull Request API responses through the typed ref boundary", () => {
  withTempRoot((rootDir) => {
    const receipt = execute(rootDir, ["snapshot", "github", "acme/widgets#110", "--json"], dependencies({
      responses: [readResponse("pull-request.json").response]
    }));

    assert.equal(receipt.ok, false);
    assert.equal(receipt.error?.code, "RefNotFound");
  });
});

function execute(
  rootDir: string,
  argv: ReadonlyArray<string>,
  deps: GithubIssuesReadDependencies
): ReturnType<typeof toCommandReceipt> {
  const parsed = parseArgs([...argv, "--root", rootDir]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error(parsed.error?.hint);
  assert.equal(parsed.value.json, true);
  const action = githubAction(parsed.value);
  const result = Effect.runSync(Effect.either(runGithubIssuesReadAction(action, deps)));
  const cliResult: CliResult = Either.isRight(result)
    ? result.right
    : { ok: false, command: action.kind === "external-snapshot" ? "snapshot-github" : "list-github", error: toCliError(result.left) };
  return toCommandReceipt(cliResult);
}

function githubAction(command: ParsedCommand): GithubIssuesReadAction {
  if (command.action.kind === "external-snapshot" || command.action.kind === "external-list") return command.action;
  throw new Error(`unexpected action: ${command.action.kind}`);
}

function dependencies(input: {
  readonly responses?: ReadonlyArray<GithubHttpResponse>;
  readonly requests?: GithubHttpRequest[];
  readonly transportError?: GithubTransportError;
  readonly credentialResolver?: GithubCredentialResolver;
}): GithubIssuesReadDependencies {
  return {
    createProvider: (options?: GithubIssuesProviderOptions) => createGithubIssuesReadProvider({
      ...options,
      transport: fakeTransport(input.responses ?? [], input.requests ?? [], input.transportError),
      credentialResolver: input.credentialResolver ?? credentialResolver(),
      clock: () => fixedDate
    })
  };
}

function fakeTransport(
  responses: ReadonlyArray<GithubHttpResponse>,
  requests: GithubHttpRequest[],
  failure?: GithubTransportError
): GithubTransport {
  let index = 0;
  return {
    request: (request) => {
      requests.push(request);
      if (failure) return Effect.fail(failure);
      const response = responses[index];
      index += 1;
      return response
        ? Effect.succeed(response)
        : Effect.fail({ _tag: "GithubNetworkFailure" });
    }
  };
}

function credentialResolver(): GithubCredentialResolver {
  return { resolve: () => Effect.succeed({ token: fakeCredential, source: "env:GH_TOKEN" }) };
}

function readResponse(name: string): { readonly response: GithubHttpResponse } {
  return JSON.parse(readFileSync(path.join(adapterFixtures, name), "utf8"));
}

function readErrorMatrix(): {
  readonly cases: ReadonlyArray<{
    readonly name: keyof { readonly unauthorized: true; readonly forbidden: true; readonly "not-found": true; readonly "rate-limit": true };
    readonly response: GithubHttpResponse;
  }>;
} {
  return JSON.parse(readFileSync(path.join(adapterFixtures, "errors.json"), "utf8"));
}

function withTempRoot(fn: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-github-cli-"));
  try {
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
