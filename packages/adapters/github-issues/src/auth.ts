import { execFile } from "node:child_process";
import { Effect } from "effect";
import type { EngineError } from "../../../kernel/src/index.ts";
import type {
  GithubCredentialResolver,
  GithubSubprocessError,
  GithubSubprocessRunner
} from "./types.ts";

export interface GithubCredentialResolverOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly subprocessRunner?: GithubSubprocessRunner;
}

const ghAuthTokenArgs = ["auth", "token"] as const;

export function makeGithubCredentialResolver(
  options: GithubCredentialResolverOptions = {}
): GithubCredentialResolver {
  const env = options.env ?? process.env;
  const subprocessRunner = options.subprocessRunner ?? makeGithubSubprocessRunner();

  return {
    resolve: () => {
      const ghToken = nonEmptyToken(env.GH_TOKEN);
      if (ghToken) return Effect.succeed({ token: ghToken, source: "env:GH_TOKEN" as const });
      const githubToken = nonEmptyToken(env.GITHUB_TOKEN);
      if (githubToken) return Effect.succeed({ token: githubToken, source: "env:GITHUB_TOKEN" as const });
      return subprocessRunner.run("gh", ghAuthTokenArgs).pipe(
        Effect.flatMap((value) => {
          const token = nonEmptyToken(value);
          return token
            ? Effect.succeed({ token, source: "keychain:gh" as const })
            : Effect.fail(authMissing());
        }),
        Effect.catchAll(() => Effect.fail(authMissing()))
      );
    }
  };
}

export function makeGithubSubprocessRunner(): GithubSubprocessRunner {
  return {
    run: (executable, args) => Effect.async<string, GithubSubprocessError>((resume) => {
      execFile(executable, [...args], { encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) {
          resume(Effect.fail({ _tag: "GithubCredentialUnavailable", source: "keychain" }));
          return;
        }
        resume(Effect.succeed(stdout));
      });
    })
  };
}

function nonEmptyToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function authMissing(): EngineError {
  return { _tag: "AuthMissing", engine: "github" };
}
