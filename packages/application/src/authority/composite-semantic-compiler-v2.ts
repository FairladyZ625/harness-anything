import {
  SemanticAdmissionErrorV2,
  type AuthoritySemanticCompilerV2
} from "./semantic-mutation-envelope-v2.ts";

export interface AuthoritySemanticCompilerRouteV2 {
  readonly commandNames: ReadonlyArray<string>;
  readonly compiler: AuthoritySemanticCompilerV2;
}

/** Routes only by the canonical typed command discriminator. */
export function makeCompositeAuthoritySemanticCompilerV2(
  routes: ReadonlyArray<AuthoritySemanticCompilerRouteV2>
): AuthoritySemanticCompilerV2 {
  const byCommand = new Map<string, AuthoritySemanticCompilerV2>();
  for (const route of routes) {
    for (const commandName of route.commandNames) {
      if (!commandName || byCommand.has(commandName)) {
        throw new Error(`AUTHORITY_SEMANTIC_COMPILER_ROUTE_INVALID:${commandName}`);
      }
      byCommand.set(commandName, route.compiler);
    }
  }
  return {
    compile: async (envelope, context) => {
      if (envelope.intent.kind !== "typed") {
        throw new SemanticAdmissionErrorV2("SEMANTIC_DIFF_REQUIRED");
      }
      const compiler = byCommand.get(envelope.intent.command.name);
      if (!compiler) throw new SemanticAdmissionErrorV2("TYPED_COMMAND_UNREGISTERED");
      return compiler.compile(envelope, context);
    }
  };
}
