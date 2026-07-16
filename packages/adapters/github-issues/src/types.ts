import type { Effect } from "effect";
import type { EngineError, LifecycleEngine, TaskListFilter } from "../../../kernel/src/index.ts";

export interface GithubRepositoryRef {
  readonly owner: string;
  readonly repo: string;
  readonly normalized: string;
}

export interface GithubIssueRef extends GithubRepositoryRef {
  readonly number: number;
  readonly normalized: string;
}

export type GithubCredentialSource = "env:GH_TOKEN" | "env:GITHUB_TOKEN" | "keychain:gh";

export interface GithubCredential {
  readonly token: string;
  readonly source: GithubCredentialSource;
}

export interface GithubCredentialResolver {
  readonly resolve: () => Effect.Effect<GithubCredential, EngineError>;
}

export interface GithubSubprocessError {
  readonly _tag: "GithubCredentialUnavailable";
  readonly source: "keychain";
}

export interface GithubSubprocessRunner {
  readonly run: (
    executable: "gh",
    args: readonly ["auth", "token"]
  ) => Effect.Effect<string, GithubSubprocessError>;
}

export interface GithubHttpRequest {
  readonly method: "GET";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface GithubHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export type GithubTransportError =
  | { readonly _tag: "GithubNetworkFailure" }
  | { readonly _tag: "GithubTransportTimeout"; readonly ms: number }
  | { readonly _tag: "GithubInvalidJson" };

export interface GithubTransport {
  readonly request: (request: GithubHttpRequest) => Effect.Effect<GithubHttpResponse, GithubTransportError>;
}

export type GithubOpenStatus = "planned" | "active" | "in_review" | "blocked";

export type GithubLabelMapping = Readonly<Partial<Record<GithubOpenStatus, ReadonlyArray<string>>>>;

export interface GithubTaskListFilter extends TaskListFilter {
  readonly repository?: string;
  readonly label?: string;
}

export interface GithubIssuesLifecycleEngine extends LifecycleEngine {
  readonly name: "github";
  readonly listTasks: (
    filter: GithubTaskListFilter
  ) => ReturnType<NonNullable<LifecycleEngine["listTasks"]>>;
}
