import {
  planTemplateMaterialization,
  validateTemplateCatalog
} from "../../../../kernel/src/index.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { decodeTemplateCatalog, invalidExtensionResult } from "./shared.ts";

type TemplateAction = Extract<ParsedCommand["action"], { readonly kind: "template-list" | "template-render" }>;

export function runTemplateCommand(action: TemplateAction): CliResult {
  if (action.kind === "template-list") {
    const decoded = decodeTemplateCatalog(action.catalogPath);
    if (!decoded.ok) {
      return invalidExtensionResult("template-list", "template_catalog_invalid", "Template catalog failed validation.", decoded.issues);
    }
    const catalog = decoded.value;
    const validation = validateTemplateCatalog(catalog);
    return {
      ok: validation.ok,
      command: "template-list",
      templates: catalog.documents.map((document) => ({
        templateRef: `template://${document.id}@${document.version}`,
        documentKind: document.documentKind,
        slot: document.slot,
        materializeAs: document.materializeAs,
        locales: document.locales.map((variant) => variant.locale)
      })),
      issues: validation.issues,
      error: validation.ok ? undefined : {
        code: "template_catalog_invalid",
        hint: "Template catalog failed validation."
      }
    };
  }

  const decoded = decodeTemplateCatalog(action.catalogPath);
  if (!decoded.ok) {
    return invalidExtensionResult("template-render", "template_catalog_invalid", "Template catalog failed validation.", decoded.issues);
  }
  const catalog = decoded.value;
  const materialized = planTemplateMaterialization({
    catalog,
    locale: action.locale,
    selections: [{
      slot: "cli.render",
      templateRef: action.templateRef,
      materializeAs: "stdout.md",
      localePolicy: {
        prefer: "explicit",
        fallback: "en-US"
      }
    }]
  });
  return {
    ok: materialized.ok,
    command: "template-render",
    document: materialized.documents[0],
    issues: materialized.issues,
    error: materialized.ok ? undefined : {
      code: "template_render_failed",
      hint: "Template selection could not be materialized."
    }
  };
}
