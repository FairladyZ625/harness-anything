import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AccessEffectivePermissionsReply,
  AccessGrantsReply,
  AccessRejection,
} from "@harness-anything/authorization-gui/access-admin-contract";
import type { FleetOverviewNode } from "../api/renderer-dto.ts";
import { guiHostBridge } from "./gui-transport.ts";
import { readIdentity, type IdentitySnapshot } from "./identity-session.ts";
import {
  collectMemberOptions,
  collectNodeOptions,
  personShortName,
  primaryTaskNodeId,
  type MemberOption,
  type NodeOption,
} from "./model/attribution.ts";
import type { TaskRow } from "./model/types.ts";
import { t } from "./i18n/index.tsx";

export interface AdminEvaluationInput {
  readonly personId: string;
  readonly repoId: string;
  readonly grantsReply: ({ readonly ok: true } & AccessGrantsReply) | AccessRejection | null | undefined;
  readonly effectiveReply?: ({ readonly ok: true } & AccessEffectivePermissionsReply) | AccessRejection | null;
}

export function evaluateAdminAccess({ personId, repoId, grantsReply, effectiveReply }: AdminEvaluationInput): {
  readonly isAdmin: boolean;
  readonly people: readonly { readonly personId: string; readonly username: string }[];
} {
  if (!grantsReply || grantsReply.ok !== true) {
    return { isAdmin: false, people: [] };
  }
  const myGrants = grantsReply.grants.filter(
    (grant) => grant.personId === personId && (grant.resource === "@fleet" || grant.resource === repoId),
  );
  if (myGrants.some((grant) => grant.groupId === "admin")) {
    return { isAdmin: true, people: grantsReply.people };
  }
  if (
    myGrants.length > 0 &&
    myGrants.every(
      (grant) => grant.groupId === "viewer" || grant.groupId === "contributor" || grant.groupId === "maintainer",
    )
  ) {
    return { isAdmin: false, people: grantsReply.people };
  }
  if (effectiveReply) {
    if (effectiveReply.ok !== true) return { isAdmin: false, people: grantsReply.people };
    const isAdmin =
      effectiveReply.actions.some((action) => action.action === "access-manage") ||
      (effectiveReply.grants.length === 0 && myGrants.length === 0);
    return { isAdmin, people: grantsReply.people };
  }
  // Daemon `grant-list` enforces `requireAccessManagement` (`access-manage` on `@fleet`).
  return { isAdmin: true, people: grantsReply.people };
}

export interface MemberScopeContext {
  readonly currentPersonId: string | null;
  readonly isAdmin: boolean;
  readonly canUseGlobalLens: boolean;
  readonly scopePersonId: string | null;
  readonly setScopePersonId: (personId: string | null) => void;
  readonly memberOptions: readonly MemberOption[];
  readonly nodeOptions: readonly NodeOption[];
  readonly peopleById: ReadonlyMap<string, string>;
  readonly nodeOwners: ReadonlyMap<string, string>;
}

export function useMemberScopeContext(input: {
  readonly repoId: string | null;
  readonly rootDir: string | undefined;
  readonly tasks: readonly TaskRow[];
  readonly fleetNodes?: readonly FleetOverviewNode[];
}): MemberScopeContext {
  const { repoId, rootDir, tasks, fleetNodes = [] } = input;
  const bridge = guiHostBridge();
  const auth = bridge?.auth && typeof bridge.auth.status === "function" ? bridge.auth : undefined;
  const access = useMemo(
    () =>
      repoId && typeof bridge?.access?.forRepository === "function" ? bridge.access.forRepository(repoId) : undefined,
    [bridge?.access, repoId],
  );

  const [identity, setIdentity] = useState<IdentitySnapshot | null>(null);
  const identitySeq = useRef(0);
  useEffect(() => {
    setIdentity(null);
    if (!auth) return;
    const refresh = () => {
      const seq = ++identitySeq.current;
      void readIdentity(auth, repoId ?? undefined, rootDir).then((snapshot) => {
        if (identitySeq.current !== seq) return;
        setIdentity(snapshot);
      });
    };
    refresh();
    window.addEventListener("harness-auth-changed", refresh);
    return () => {
      identitySeq.current += 1;
      window.removeEventListener("harness-auth-changed", refresh);
    };
  }, [auth, repoId, rootDir]);

  const currentPersonId = identity?.phase === "ready" && identity.authenticated ? identity.personId : null;

  const [adminState, setAdminState] = useState<{
    readonly isAdmin: boolean;
    readonly people: readonly { readonly personId: string; readonly username: string }[];
  }>({ isAdmin: false, people: [] });
  const adminSeq = useRef(0);

  useEffect(() => {
    setAdminState({ isAdmin: false, people: [] });
    if (!currentPersonId || !repoId || !access || typeof access.grants !== "function") return;
    const seq = ++adminSeq.current;
    void (async () => {
      const grantsReply = await access.grants().catch(() => null);
      if (adminSeq.current !== seq) return;
      if (!grantsReply || grantsReply.ok !== true) {
        setAdminState({ isAdmin: false, people: [] });
        return;
      }
      const myGrants = grantsReply.grants.filter(
        (grant) => grant.personId === currentPersonId && (grant.resource === "@fleet" || grant.resource === repoId),
      );
      const needsEffectiveCheck =
        myGrants.length === 0 ||
        (!myGrants.some((grant) => grant.groupId === "admin") &&
          !myGrants.every(
            (grant) => grant.groupId === "viewer" || grant.groupId === "contributor" || grant.groupId === "maintainer",
          ));
      const effectiveReply =
        needsEffectiveCheck && typeof access.effectivePermissions === "function"
          ? await access.effectivePermissions({ personId: currentPersonId, resource: "@fleet" }).catch(() => null)
          : undefined;
      if (adminSeq.current !== seq) return;
      setAdminState(
        evaluateAdminAccess({
          personId: currentPersonId,
          repoId,
          grantsReply,
          effectiveReply,
        }),
      );
    })();
    return () => {
      adminSeq.current += 1;
    };
  }, [access, currentPersonId, repoId]);

  const peopleById = useMemo(
    () => new Map(adminState.people.map((person) => [person.personId, person.username] as const)),
    [adminState.people],
  );

  const nodeOwners = useMemo(() => {
    const owners = new Map<string, string>();
    for (const node of fleetNodes) {
      if (
        node.role === "edge" &&
        node.owner.kind === "value" &&
        node.owner.text !== "" &&
        node.owner.text !== "not-in-registry"
      ) {
        owners.set(node.nodeId, node.owner.text);
      }
    }
    return owners;
  }, [fleetNodes]);

  const memberOptions = useMemo(
    () =>
      collectMemberOptions({
        tasks,
        knownMembers: adminState.people.map((person) => ({
          personId: person.personId,
          label: person.username || personShortName(person.personId),
        })),
        extraPersonIds: [...nodeOwners.values()],
        currentPersonId,
        peopleById,
      }),
    [tasks, adminState.people, nodeOwners, currentPersonId, peopleById],
  );

  const nodeOptions = useMemo(
    () =>
      collectNodeOptions({
        tasks,
        knownNodes: fleetNodes.map((node) => ({
          nodeId: node.nodeId,
          ownerPersonId: node.role === "center" ? null : (nodeOwners.get(node.nodeId) ?? null),
          label: node.nodeId,
        })),
        nodeOwners,
        peopleById,
        centerLabel: t("collaboration.centerNode"),
      }),
    [tasks, fleetNodes, nodeOwners, peopleById],
  );

  const hasExternalNodes = useMemo(
    () =>
      fleetNodes.some((node) => node.role === "edge") ||
      tasks.some((task) => {
        const nodeId = primaryTaskNodeId(task);
        return nodeId !== null && nodeId !== "center";
      }),
    [fleetNodes, tasks],
  );

  const canUseGlobalLens =
    adminState.isAdmin && currentPersonId !== null && (memberOptions.length >= 2 || hasExternalNodes);

  const [scopePersonId, setScopePersonId] = useState<string | null>(null);
  useEffect(() => {
    setScopePersonId(null);
  }, [repoId]);
  useEffect(() => {
    if (!canUseGlobalLens) setScopePersonId(null);
  }, [canUseGlobalLens]);

  return {
    currentPersonId,
    isAdmin: adminState.isAdmin,
    canUseGlobalLens,
    scopePersonId,
    setScopePersonId,
    memberOptions,
    nodeOptions,
    peopleById,
    nodeOwners,
  };
}
