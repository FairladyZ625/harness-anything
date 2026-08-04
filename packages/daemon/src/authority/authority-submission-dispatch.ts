// @slice-activation PLT-Boundary W2 daemon-owned authority submission dispatch host.
import type { AuthorityConnectionDispatch } from "../protocol/connection-context.ts";
import type { AuthorityRepoComponent } from "./authority-lifecycle.ts";

export function bindAuthoritySubmissionForDispatch(
  component: AuthorityRepoComponent,
  repoId: string,
  dispatch: AuthorityConnectionDispatch | undefined
): ReturnType<AuthorityRepoComponent["bindConnection"]> | undefined {
  if (!dispatch?.available) return undefined;
  if (dispatch.context.repoId !== repoId) throw new Error("AUTHORITY_CONNECTION_REPO_MISMATCH");
  dispatch.assertActive();
  const bound = component.bindConnection(dispatch.context);
  return {
    ...(bound.planCommand ? {
      planCommand: async (input) => {
        dispatch.assertActive();
        return bound.planCommand!(input);
      }
    } : {}),
    submit: async (submission) => {
      dispatch.assertActive();
      return bound.submit(submission);
    }
  };
}

export function requireAuthoritySubmissionForDispatch(
  component: AuthorityRepoComponent,
  repoId: string,
  dispatch: AuthorityConnectionDispatch | undefined
): ReturnType<AuthorityRepoComponent["bindConnection"]> {
  const bound = bindAuthoritySubmissionForDispatch(component, repoId, dispatch);
  if (!bound) throw new Error("AUTHORITY_CONNECTION_REQUIRED");
  return bound;
}
