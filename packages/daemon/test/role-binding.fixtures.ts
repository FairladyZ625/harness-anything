import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ActorIdentity, RoleBinding } from "@harness-anything/kernel";

export function withRoleBinding<
  T extends {
    readonly actor: ActorIdentity;
    readonly roleBindings?: readonly RoleBinding[];
  },
>(binding: T, role: string): T & { readonly roleBindings: readonly RoleBinding[] } {
  return {
    ...binding,
    roleBindings: [
      ...(binding.roleBindings ?? []),
      {
        actor: { kind: "person", id: binding.actor.principal.personId },
        role,
        target: "settings/repository",
        source: "declared",
        expiresAt: null,
      },
    ],
  };
}

/** Explicit roster authority for fixtures that exercise runtime revalidation. */
export function writeOwnerRoster(rootDir: string, personIds: readonly string[]): void {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    JSON.stringify({
      schema: "harness-people/v1",
      people: personIds.map((personId) => ({
        personId,
        displayName: personId,
        roles: ["fixture-owner"],
        credentials: [],
      })),
      roles: [{ roleId: "fixture-owner", commandClasses: ["repo-read", "repo-write", "arbiter", "admin"] }],
    }),
  );
}
