import type { ProductionCanonicalIngressFixture } from "./fixture.ts";
import { verifyDecisionProposeParity } from "./propose-parity.ts";
import { verifyReviewVerdictCompanions } from "./review-verdict-companions.ts";

export function verifyProductionCommandParity(
  fixture: ProductionCanonicalIngressFixture,
  env: NodeJS.ProcessEnv
): void {
  verifyDecisionProposeParity(fixture, env);
  verifyReviewVerdictCompanions(fixture, env);
}
