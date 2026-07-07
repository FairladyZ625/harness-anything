import { Schema } from "effect";
import { docmapDocumentKinds } from "../domain/docmap.ts";

const IdentifierSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/u));
const PortableDocumentPathSchema = Schema.String.pipe(Schema.pattern(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/).+$/u));
const StringArray = Schema.Array(Schema.String);

export const DocmapDocumentSchema = Schema.Struct({
  id: IdentifierSchema,
  path: PortableDocumentPathSchema,
  kind: Schema.Literal(...docmapDocumentKinds),
  scope: Schema.Struct({
    modules: StringArray,
    productLines: StringArray
  }),
  updatedAt: Schema.String,
  supersedes: Schema.optional(Schema.Array(IdentifierSchema)),
  supersededBy: Schema.optional(IdentifierSchema),
  unused: Schema.optional(Schema.Boolean)
});

export const DocmapManifestSchema = Schema.Struct({
  schema: Schema.Literal("docmap/v1"),
  documents: Schema.Array(DocmapDocumentSchema)
});

export type DocmapManifestDocument = Schema.Schema.Type<typeof DocmapManifestSchema>;
