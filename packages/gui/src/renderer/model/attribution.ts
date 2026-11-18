import { actorDisplayName } from "./actor-name.ts";
import { leaseNodeIdOf } from "./collaboration.ts";
import type { TaskRow } from "./types.ts";

export const CENTER_NODE_ID = "center";

export interface MemberOption {
  readonly personId: string;
  readonly label: string;
}

export interface NodeOption {
  readonly nodeId: string;
  readonly ownerPersonId: string | null;
  readonly label: string;
}

const UUID_OR_HEX_NODE_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{12,}$)/iu;

/** Shortens raw UUID / long hex node IDs to 6 chars while keeping semantic hostnames intact. */
export function shortNodeCode(nodeId: string): string {
  if (nodeId === CENTER_NODE_ID) return CENTER_NODE_ID;
  return UUID_OR_HEX_NODE_RE.test(nodeId) ? nodeId.slice(0, 6) : nodeId;
}

/** Readable person short name, preferring an explicit directory username when provided. */
export function personShortName(personId: string, peopleById?: ReadonlyMap<string, string>): string {
  const mapped = peopleById?.get(personId)?.trim();
  if (mapped) return mapped;
  return actorDisplayName(personId).name;
}

/** Formats a center or edge node as `center` (or localized short label) or `<owner> · <shortNodeCode>`. */
export function formatNodeDisplay(
  nodeId: string,
  ownerPersonId?: string | null,
  options?: {
    readonly centerLabel?: string;
    readonly peopleById?: ReadonlyMap<string, string>;
  },
): string {
  if (nodeId === CENTER_NODE_ID) return options?.centerLabel ?? CENTER_NODE_ID;
  const code = shortNodeCode(nodeId);
  const cleanOwner =
    ownerPersonId && ownerPersonId !== "not-in-registry" && ownerPersonId !== "daemon" ? ownerPersonId : null;
  if (!cleanOwner) return code;
  return `${personShortName(cleanOwner, options?.peopleById)} · ${code}`;
}

/**
 * Low-noise attribution capsule (CH3): renders ONLY when the item belongs to another person
 * (relative to `currentPersonId`) or runs/originates on a non-center edge node.
 * Single-user local `center` items return null for zero visual noise.
 */
export function attributionBadgeOf(input: {
  readonly personId: string | null | undefined;
  readonly nodeId: string | null | undefined;
  readonly currentPersonId?: string | null;
  readonly nodeOwners?: ReadonlyMap<string, string>;
  readonly peopleById?: ReadonlyMap<string, string>;
  readonly centerLabel?: string;
}): { readonly label: string; readonly title: string } | null {
  const personId = input.personId ?? null;
  const nodeId = input.nodeId ?? null;
  const currentPersonId = input.currentPersonId ?? null;
  const isEdgeNode = nodeId !== null && nodeId !== CENTER_NODE_ID;
  const isForeignPerson = personId !== null && currentPersonId !== null && personId !== currentPersonId;
  if (!isEdgeNode && !isForeignPerson) return null;

  const effectivePersonId = personId ?? (nodeId ? (input.nodeOwners?.get(nodeId) ?? null) : null);
  const personLabel = effectivePersonId ? personShortName(effectivePersonId, input.peopleById) : null;
  const nodeLabel =
    nodeId === null ? null : nodeId === CENTER_NODE_ID ? (input.centerLabel ?? CENTER_NODE_ID) : shortNodeCode(nodeId);
  const label = personLabel && nodeLabel ? `${personLabel} · ${nodeLabel}` : (nodeLabel ?? personLabel);
  if (!label) return null;
  const title = [effectivePersonId, nodeId].filter((part): part is string => Boolean(part)).join(" · ");
  return { label, title };
}

export function primaryTaskPersonId(task: TaskRow): string | null {
  return (
    task.activeOrLatestPersonId ??
    task.createdByPersonId ??
    task.leaseActor?.principal.personId ??
    (task.assignment?.assignee?.kind === "person" ? task.assignment.assignee.personId : undefined) ??
    task.createdBy ??
    null
  );
}

export function primaryTaskNodeId(task: TaskRow): string | null {
  return task.activeOrLatestNodeId ?? leaseNodeIdOf(task.leaseSource) ?? task.originNodeId ?? null;
}

export function taskMatchesPerson(task: TaskRow, personId: string): boolean {
  return (
    task.createdByPersonId === personId ||
    task.activeOrLatestPersonId === personId ||
    task.createdBy === personId ||
    task.leaseActor?.principal.personId === personId ||
    (task.assignment?.assignee?.kind === "person" && task.assignment.assignee.personId === personId)
  );
}

export function taskMatchesNode(task: TaskRow, nodeId: string): boolean {
  return (
    task.activeOrLatestNodeId === nodeId || task.originNodeId === nodeId || leaseNodeIdOf(task.leaseSource) === nodeId
  );
}

export function collectMemberOptions(input: {
  readonly tasks?: readonly TaskRow[];
  readonly knownMembers?: readonly MemberOption[];
  readonly extraPersonIds?: readonly (string | null | undefined)[];
  readonly currentPersonId?: string | null;
  readonly peopleById?: ReadonlyMap<string, string>;
}): readonly MemberOption[] {
  const byId = new Map<string, string>();
  const add = (personId: string | null | undefined, label?: string) => {
    if (!personId || personId === "not-in-registry" || personId === "daemon") return;
    if (!byId.has(personId)) {
      byId.set(personId, label?.trim() || personShortName(personId, input.peopleById));
    }
  };
  if (input.currentPersonId) add(input.currentPersonId);
  for (const member of input.knownMembers ?? []) add(member.personId, member.label);
  for (const task of input.tasks ?? []) {
    add(task.createdByPersonId);
    add(task.activeOrLatestPersonId);
    add(task.createdBy);
    add(task.leaseActor?.principal.personId);
    if (task.assignment?.assignee?.kind === "person") add(task.assignment.assignee.personId);
  }
  for (const personId of input.extraPersonIds ?? []) add(personId);
  return [...byId.entries()]
    .map(([personId, label]) => ({ personId, label }))
    .sort((left, right) => {
      if (input.currentPersonId) {
        if (left.personId === input.currentPersonId) return -1;
        if (right.personId === input.currentPersonId) return 1;
      }
      return left.label.localeCompare(right.label);
    });
}

export function collectNodeOptions(input: {
  readonly tasks?: readonly TaskRow[];
  readonly knownNodes?: readonly NodeOption[];
  readonly extraNodes?: readonly {
    readonly nodeId: string | null | undefined;
    readonly ownerPersonId?: string | null;
  }[];
  readonly nodeOwners?: ReadonlyMap<string, string>;
  readonly peopleById?: ReadonlyMap<string, string>;
  readonly centerLabel?: string;
}): readonly NodeOption[] {
  const owners = new Map<string, string | null>();
  const add = (nodeId: string | null | undefined, ownerPersonId?: string | null) => {
    if (!nodeId) return;
    const cleanOwner =
      ownerPersonId && ownerPersonId !== "not-in-registry" && ownerPersonId !== "daemon"
        ? ownerPersonId
        : (input.nodeOwners?.get(nodeId) ?? null);
    if (!owners.has(nodeId) || (owners.get(nodeId) === null && cleanOwner !== null)) {
      owners.set(nodeId, cleanOwner);
    }
  };
  for (const node of input.knownNodes ?? []) add(node.nodeId, node.ownerPersonId);
  for (const task of input.tasks ?? []) {
    const fallbackPerson = primaryTaskPersonId(task);
    add(task.activeOrLatestNodeId, task.activeOrLatestPersonId ?? fallbackPerson);
    add(task.originNodeId, task.createdByPersonId ?? fallbackPerson);
    add(leaseNodeIdOf(task.leaseSource), task.leaseActor?.principal.personId ?? fallbackPerson);
  }
  for (const extra of input.extraNodes ?? []) add(extra.nodeId, extra.ownerPersonId);
  return [...owners.entries()]
    .map(([nodeId, ownerPersonId]) => ({
      nodeId,
      ownerPersonId,
      label: formatNodeDisplay(nodeId, ownerPersonId, {
        centerLabel: input.centerLabel,
        peopleById: input.peopleById,
      }),
    }))
    .sort((left, right) => {
      if (left.nodeId === CENTER_NODE_ID) return -1;
      if (right.nodeId === CENTER_NODE_ID) return 1;
      return left.label.localeCompare(right.label);
    });
}
