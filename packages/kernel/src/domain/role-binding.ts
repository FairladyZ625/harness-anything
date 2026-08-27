import type { ActorIdentity } from "./actor-identity.ts";
import { parseEntityRef, type EntityRef } from "./entity-ref.ts";

export const roleBindingSources = Object.freeze(["derived", "declared"] as const);
export type RoleBindingSource = (typeof roleBindingSources)[number];

export const roleBindingActorKinds = Object.freeze(["person", "executor"] as const);
export type RoleBindingActorKind = (typeof roleBindingActorKinds)[number];

export interface RoleBindingActor {
  readonly kind: RoleBindingActorKind;
  readonly id: string;
}

/** A role held by one Actor axis on one EntityRef at an optional point-in-time boundary. */
export interface RoleBinding {
  readonly actor: RoleBindingActor;
  readonly role: string;
  readonly target: EntityRef;
  readonly source: RoleBindingSource;
  readonly expiresAt: string | null;
}

export interface RoleCommandClassDeclaration {
  readonly roleId: string;
  readonly commandClasses: readonly string[];
}

export class RoleBindingContractError extends Error {
  readonly code = "invalid_role_binding";

  constructor(message: string) {
    super(message);
    this.name = "RoleBindingContractError";
  }
}

export function parseRoleBinding(value: unknown): RoleBinding {
  const errors = validateRoleBinding(value);
  if (errors.length) throw new RoleBindingContractError(errors.join("; "));
  const binding = value as RoleBinding;
  return {
    actor: { kind: binding.actor.kind, id: binding.actor.id.trim() },
    role: binding.role.trim(),
    target: binding.target,
    source: binding.source,
    expiresAt: binding.expiresAt,
  };
}

export function validateRoleBinding(value: unknown): readonly string[] {
  if (!roleBindingRecord(value)) return ["RoleBinding must be an object"];
  const errors: string[] = [],
    fields = ["actor", "role", "target", "source", "expiresAt"],
    unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length) errors.push(`RoleBinding has unsupported fields: ${unknown.join(", ")}`);
  if (!fields.every((field) => Object.hasOwn(value, field)))
    errors.push("RoleBinding requires actor, role, target, source, and expiresAt");
  if (!roleBindingRecord(value.actor)) errors.push("RoleBinding actor must be an object");
  else {
    if (Object.keys(value.actor).some((field) => field !== "kind" && field !== "id"))
      errors.push("RoleBinding actor only accepts kind and id");
    if (!roleBindingActorKinds.includes(value.actor.kind as RoleBindingActorKind))
      errors.push("RoleBinding actor kind must be person or executor");
    if (typeof value.actor.id !== "string" || !value.actor.id.trim()) errors.push("RoleBinding actor id is required");
  }
  if (typeof value.role !== "string" || !value.role.trim()) errors.push("RoleBinding role is required");
  if (typeof value.target !== "string" || parseEntityRef(value.target) === null)
    errors.push("RoleBinding target must be an EntityRef");
  if (!roleBindingSources.includes(value.source as RoleBindingSource))
    errors.push("RoleBinding source must be derived or declared");
  if (value.expiresAt !== null && !isUtcTimestamp(value.expiresAt))
    errors.push("RoleBinding expiresAt must be null or an ISO-8601 UTC timestamp ending in Z");
  return errors;
}

/** Derive repository-scoped RoleBindings without materializing a second role-to-command-class map. */
export function deriveRoleBindings(input: {
  readonly actor: ActorIdentity;
  readonly roleIds: readonly string[];
  readonly roleDeclarations: readonly RoleCommandClassDeclaration[];
  readonly target: EntityRef;
}): readonly RoleBinding[] {
  const bindings: RoleBinding[] = [];
  for (const roleId of input.roleIds) {
    const declaration = input.roleDeclarations.find((candidate) => candidate.roleId === roleId);
    for (const commandClass of declaration?.commandClasses ?? []) {
      if (bindings.some((binding) => binding.role === commandClass)) continue;
      bindings.push({
        actor: { kind: "person", id: input.actor.principal.personId },
        role: commandClass,
        target: input.target,
        source: "derived",
        expiresAt: null,
      });
    }
  }
  return Object.freeze(bindings);
}

export function roleBindingApplies(
  binding: RoleBinding,
  actor: ActorIdentity,
  role: string,
  targets: readonly EntityRef[],
  evaluatedAt?: string,
): boolean {
  return (
    binding.role === role &&
    roleBindingActorMatches(binding.actor, actor) &&
    targets.includes(binding.target) &&
    !roleBindingExpired(binding, evaluatedAt)
  );
}

export function roleBindingActorMatches(bindingActor: RoleBindingActor, actor: ActorIdentity): boolean {
  return bindingActor.kind === "person"
    ? bindingActor.id === actor.principal.personId
    : actor.executor !== null && bindingActor.id === actor.executor.id;
}

export function roleBindingExpired(binding: RoleBinding, evaluatedAt?: string): boolean {
  if (binding.expiresAt === null) return false;
  const at = evaluatedAt && isUtcTimestamp(evaluatedAt) ? evaluatedAt : new Date().toISOString();
  return Date.parse(binding.expiresAt) <= Date.parse(at);
}

export function roleBindingKey(binding: RoleBinding): string {
  return `${binding.actor.kind}\0${binding.actor.id}\0${binding.role}\0${binding.target}`;
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(value);
}

function roleBindingRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
