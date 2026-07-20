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
    } : {}),
    ...(bound.submitTaskClaim ? {
      submitTaskClaim: async (submission: Parameters<NonNullable<typeof bound.submitTaskClaim>>[0]) => {
        dispatch.assertActive();
        return bound.submitTaskClaim!(submission);
      }
    } : {}),
    ...(bound.submitObservedWrite ? {
      submitObservedWrite: async (submission: Parameters<NonNullable<typeof bound.submitObservedWrite>>[0]) => {
        dispatch.assertActive();
        return bound.submitObservedWrite!(submission);
      }
    } : {}),
    ...(bound.submitScriptIngest ? {
      submitScriptIngest: async (submission: Parameters<NonNullable<typeof bound.submitScriptIngest>>[0]) => {
        dispatch.assertActive();
        return bound.submitScriptIngest!(submission);
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
