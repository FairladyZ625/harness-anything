import type { DaemonHost } from "../daemon-host-types.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import type { SkillEvalCaseDraft } from "../skill-eval-runner.ts";
import type { DaemonRpcCall, DaemonRpcMethod, DaemonRpcResult } from "./daemon-protocol.contract.ts";

type SkillEvalMethod = Extract<DaemonRpcMethod, `daemon.skillEval.${string}`>;
type SkillEvalCall = Extract<DaemonRpcCall, { readonly method: SkillEvalMethod }>;

export function isSkillEvalCall(call: DaemonRpcCall): call is SkillEvalCall {
  return call.method.startsWith("daemon.skillEval.");
}

export async function dispatchSkillEvalCall(
  call: SkillEvalCall,
  service: DaemonHost["skillEval"],
  auth: DaemonAuthenticationContext,
): Promise<DaemonRpcResult<SkillEvalMethod>> {
  switch (call.method) {
    case "daemon.skillEval.version.register":
      return {
        ok: true,
        skill: await service.registerVersion(auth, {
          ...call.params,
          requiredText: call.params.requiredText as readonly string[] | undefined,
        }),
      };
    case "daemon.skillEval.case.add": {
      const { skillId, ...draft } = call.params;
      return { ok: true, case: await service.addCase(auth, skillId, draft as SkillEvalCaseDraft) };
    }
    case "daemon.skillEval.cases.list":
      return { ok: true, cases: await service.listCases(auth, call.params.skillId) };
    case "daemon.skillEval.run":
      return {
        ok: true,
        evaluation: await service.run(auth, call.params.skillId, call.params.version, {
          ...(call.params.threshold === undefined ? {} : { threshold: call.params.threshold }),
        }),
      };
  }
}
