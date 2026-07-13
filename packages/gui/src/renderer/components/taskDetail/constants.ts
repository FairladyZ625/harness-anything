import type { CanonicalStatus, RelationKind } from "../../model/types";
import { t } from "../../i18n/core.ts";

export const LOCAL_TRANSITIONS: CanonicalStatus[] = [
  "planned",
  "active",
  "blocked",
  "in_review",
  "done",
  "cancelled",
];

export const STEP_FLOW: CanonicalStatus[] = ["planned", "active", "in_review", "done"];

export const OUT_LABEL: Record<RelationKind, string> = {
  get supports() { return t("components.constants.support"); },
  get supersedes() { return t("components.constants.overthrow"); },
  get refines() { return t("components.constants.refine"); },
  get narrows() { return t("components.constants.narrow"); },
  get derives() { return t("components.constants.derived"); },
  get blocks() { return t("components.constants.blocking"); },
  get relates() { return t("components.constants.association"); },
  get implements() { return t("components.constants.realize"); },
  get "depends-on"() { return t("components.constants.depend"); },
  get produces() { return t("components.constants.output"); },
  get evidences() { return t("components.constants.prove"); },
  get "evidenced-by"() { return t("components.constants.evidence"); },
  get refutes() { return t("components.constants.counterevidence"); },
  get "invalidated-by"() { return t("components.constants.invalid"); },
  get "supersedes-fact"() { return t("components.constants.replaceFacts"); },
};

export const IN_LABEL: Record<RelationKind, string> = {
  get supports() { return t("components.constants.support2"); },
  get supersedes() { return t("components.constants.overturned"); },
  get refines() { return t("components.constants.refined"); },
  get narrows() { return t("components.constants.narrowed"); },
  get derives() { return t("components.constants.derivedFrom"); },
  get blocks() { return t("components.constants.blocked"); },
  get relates() { return t("components.constants.association"); },
  get implements() { return t("components.constants.realized"); },
  get "depends-on"() { return t("components.constants.depended"); },
  get produces() { return t("components.constants.producedBy"); },
  get evidences() { return t("components.constants.proven"); },
  get "evidenced-by"() { return t("components.constants.evidenceComesFrom"); },
  get refutes() { return t("components.constants.disproved"); },
  get "invalidated-by"() { return t("components.constants.invalidate"); },
  get "supersedes-fact"() { return t("components.constants.factsReplaced"); },
};
