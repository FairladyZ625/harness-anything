import type {
  ExactWriteCoordinator,
  ExactWriteScope
} from "@harness-anything/kernel";
import type { AuthoritySubmissionServiceOptions } from "./service-options.ts";

export function createPromiseSerializer(): <Result>(operation: () => Promise<Result>) => Promise<Result> {
  let tail = Promise.resolve();
  return <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function createCachedAuthorityCoordinator(input: {
  readonly coordinatorFactory: AuthoritySubmissionServiceOptions["coordinatorFactory"];
  readonly exactWriteScopes: Map<string, ExactWriteScope>;
  readonly attribution: Parameters<AuthoritySubmissionServiceOptions["coordinatorFactory"]["create"]>[0]["attribution"];
  readonly sessionId: string;
  readonly createExactWriteScope: () => ExactWriteScope;
}): ExactWriteCoordinator {
  let exactWriteScope = input.exactWriteScopes.get(input.sessionId);
  if (!exactWriteScope) {
    exactWriteScope = input.createExactWriteScope();
    input.exactWriteScopes.set(input.sessionId, exactWriteScope);
  }
  const coordinator = input.coordinatorFactory.create({
    attribution: input.attribution,
    sessionId: input.sessionId,
    exactWriteScope
  });
  return {
    enqueue: coordinator.enqueue,
    commitExact: coordinator.commitExact,
    recover: coordinator.recover
  };
}

export function createAuthorityCoordinatorResolver(input: {
  readonly coordinatorFactory: AuthoritySubmissionServiceOptions["coordinatorFactory"];
  readonly exactWriteScopes: Map<string, ExactWriteScope>;
  readonly createExactWriteScope: () => ExactWriteScope;
}): (
  attribution: Parameters<AuthoritySubmissionServiceOptions["coordinatorFactory"]["create"]>[0]["attribution"],
  sessionId: string
) => ExactWriteCoordinator {
  return (attribution, sessionId) => createCachedAuthorityCoordinator({
    ...input,
    attribution,
    sessionId
  });
}

export function authorityServiceErrorDescription(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = (error as { readonly cause?: unknown }).cause;
    return `${"_tag" in error ? String((error as { readonly _tag?: unknown })._tag) : "error"}:${authorityServiceErrorDescription(cause)}`;
  }
  return String(error);
}
