import type { AuthorityConnectionDispatch } from "../../../daemon/src/index.ts";
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
    submit: async (submission) => {
      dispatch.assertActive();
      return bound.submit(submission);
    },
    ...(bound.submitProvenanceSession ? {
      submitProvenanceSession: async (submission: Parameters<NonNullable<typeof bound.submitProvenanceSession>>[0]) => {
        dispatch.assertActive();
        return bound.submitProvenanceSession!(submission);
      }
    } : {}),
    ...(bound.submitDecisionTransition ? {
      submitDecisionTransition: async (submission: Parameters<NonNullable<typeof bound.submitDecisionTransition>>[0]) => {
        dispatch.assertActive();
        return bound.submitDecisionTransition!(submission);
      }
    } : {})
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
