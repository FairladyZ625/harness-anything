import { Context, Effect } from "effect";
import type { TemplateLibraryError } from "../domain/index.js";

export type Locale = "zh-CN" | "en-US";

export interface TemplateRef {
  readonly id: string;
  readonly locale: Locale;
}

export interface TemplateDocument {
  readonly ref: TemplateRef;
  readonly documentKind: string;
  readonly body: string;
  readonly slots: ReadonlyArray<string>;
}

export interface TemplateLibrary {
  readonly listTemplates: () => Effect.Effect<ReadonlyArray<TemplateRef>, TemplateLibraryError>;
  readonly getTemplate: (ref: TemplateRef) => Effect.Effect<TemplateDocument, TemplateLibraryError>;
}

export const TemplateLibrary = Context.GenericTag<TemplateLibrary>(
  "@harness-anything/kernel/TemplateLibrary"
);
