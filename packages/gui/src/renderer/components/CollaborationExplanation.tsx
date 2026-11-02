import { Notice } from "./primitives/Notice.tsx";
import { t } from "../i18n/index.tsx";

/** A provider refusal is an explanation, never an empty successful result. */
export function CollaborationExplanation() {
  return (
    <section className="flex min-w-0 flex-1 flex-col p-5" data-testid="collaboration-explanation">
      <h1 className="text-xl font-semibold text-text">{t("collaborationExplanation.title")}</h1>
      <Notice tone="neutral">
        <p>{t("collaborationExplanation.description")}</p>
        <a
          className="underline"
          href="https://github.com/FairladyZ625/harness-anything/blob/main/docs-release/builtin-identity-provider.md#keycloak-plugin"
          target="_blank"
          rel="noreferrer"
        >
          {t("collaborationExplanation.documentation")}
        </a>
      </Notice>
    </section>
  );
}
