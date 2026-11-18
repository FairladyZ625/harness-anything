import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AccessEffectivePermissionsReply,
  AccessGrantsReply,
  AccessRejection,
} from "@harness-anything/authorization-gui/access-admin-contract";
import type { FleetOverviewNode } from "../api/renderer-dto.ts";
import { scopeOfResource } from "./access-model.ts";
import { guiHostBridge, guiTransport } from "./gui-transport.ts";
import { repositoryReadFailure } from "./repository-read-frame.ts";
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

export interface RepoAdminExplainAction {
  readonly action?: { readonly kind?: string; readonly id?: string } | null;
  readonly authorizationDecision?: { readonly outcome?: string } | null;
}

export interface RepoAdminExplainReply {
  readonly ok?: boolean;
  readonly subjects?: readonly {
    readonly ref?: string;
    readonly failure?: { readonly code?: string } | null;
    readonly actions?: readonly RepoAdminExplainAction[];
  }[];
}

export interface AccessPersonRecord {
  readonly personId: string;
  readonly username: string;
}

async function explainRepoPersonActions(repoId: string, personId: string): Promise<RepoAdminExplainReply | null> {
  const result = await guiTransport().request(
    "repo.entity.actions.explain",
    {
      repo: { repoId },
      payload: {
        schema: "entity-action-explain-request/v1",
        mode: "object",
        entityKind: null,
        refs: [`person/${personId}`],
      },
    },
    "explainEntityActions",
  );
  const failure = repositoryReadFailure(result);
  if (failure) {
    if ((failure as Error & { readonly code?: string }).code === "authentication_required") {
      window.dispatchEvent(new Event("harness-auth-changed"));
    }
    throw failure;
  }
  return result as unknown as RepoAdminExplainReply;
}

export function evaluateRepoAdminFromExplain(
  personId: string | null | undefined,
  reply: RepoAdminExplainReply | null | undefined,
): boolean {
  if (!personId || personId.trim() === "" || !reply || reply.ok === false || !Array.isArray(reply.subjects)) {
    return false;
  }
  const targetRef = `person/${personId}`;
  const subject = reply.subjects.find((entry) => entry?.ref === targetRef);
  if (!subject || subject.failure != null || !Array.isArray(subject.actions)) {
    return false;
  }
  const delegateAction = subject.actions.find(
    (entry: RepoAdminExplainAction) =>
      (entry?.action?.kind === undefined || entry.action.kind === "person") &&
      (entry?.action?.id === "delegate" || entry?.action?.id === "person/delegate"),
  );
  return delegateAction?.authorizationDecision?.outcome === "allowed";
}

export function evaluateFleetNodeAdminAccess(
  effectiveReply: ({ readonly ok: true } & AccessEffectivePermissionsReply) | AccessRejection | null | undefined,
): boolean {
  return Boolean(
    effectiveReply &&
      effectiveReply.ok === true &&
      effectiveReply.actions.some((action) => action.action === "access-manage"),
  );
}

export function grantAppliesToRepository(resource: string, repoId: string): boolean {
  if (!repoId) return false;
  const scope = scopeOfResource(resource);
  return scope.kind === "fleet" || scope.repoId === repoId;
}

export function filterRepoKnownMembers(
  repoId: string,
  grantsReply: ({ readonly ok: true } & AccessGrantsReply) | AccessRejection | null | undefined,
): {
  readonly memberPeople: readonly AccessPersonRecord[];
  readonly allPeople: readonly AccessPersonRecord[];
} {
  if (!grantsReply || grantsReply.ok !== true) {
    return { memberPeople: [], allPeople: [] };
  }
  const eligiblePersonIds = new Set(
    grantsReply.grants
      .filter((grant) => grantAppliesToRepository(grant.resource, repoId))
      .map((grant) => grant.personId),
  );
  return {
    memberPeople: grantsReply.people.filter((person) => eligiblePersonIds.has(person.personId)),
    allPeople: grantsReply.people,
  };
}

export interface MemberScopeContext {
  readonly currentPersonId: string | null;
  readonly isAdmin: boolean;
  readonly canManageFleetNodes: boolean;
  readonly canUseGlobalLens: boolean;
  readonly scopePersonId: string | null;
  readonly setScopePersonId: (personId: string | null) => void;
  readonly memberOptions: readonly MemberOption[];
  readonly nodeOptions: readonly NodeOption[];
  readonly peopleById: ReadonlyMap<string, string>;
  readonly nodeOwners: ReadonlyMap<string, string>;
}

const EMPTY_ADMIN_STATE: {
  readonly isRepoAdmin: boolean;
  readonly canManageFleetNodes: boolean;
  readonly memberPeople: readonly AccessPersonRecord[];
  readonly allPeople: readonly AccessPersonRecord[];
} = {
  isRepoAdmin: false,
  canManageFleetNodes: false,
  memberPeople: [],
  allPeople: [],
};

export function useMemberScopeContext(input: {
  readonly repoId: string | null;
  readonly rootDir: string | undefined;
  readonly tasks: readonly TaskRow[];
  readonly fleetNodes?: readonly FleetOverviewNode[];
  readonly view?: string;
}): MemberScopeContext {
  const { repoId, rootDir, tasks, fleetNodes = [], view } = input;
  const bridge = guiHostBridge();
  const auth = bridge?.auth && typeof bridge.auth.status === "function" ? bridge.auth : undefined;
  const access = useMemo(
    () =>
      repoId && typeof bridge?.access?.forRepository === "function" ? bridge.access.forRepository(repoId) : undefined,
    [bridge?.access, repoId],
  );

  const [identity, setIdentity] = useState<IdentitySnapshot | null>(null);
  const [authEpoch, setAuthEpoch] = useState(0);
  const identitySeq = useRef(0);
  useEffect(() => {
    setIdentity(null);
    if (!auth) return;
    const refreshIdentity = () => {
      const seq = ++identitySeq.current;
      void readIdentity(auth, repoId ?? undefined, rootDir).then((snapshot) => {
        if (identitySeq.current !== seq) return;
        setIdentity(snapshot);
      });
    };
    const refreshAuthAndGrants = () => {
      refreshIdentity();
      setAuthEpoch((epoch) => epoch + 1);
    };
    const refreshAccessOnly = () => {
      setAuthEpoch((epoch) => epoch + 1);
    };
    refreshIdentity();
    window.addEventListener("harness-auth-changed", refreshAuthAndGrants);
    window.addEventListener("harness-auth-signed-in", refreshAuthAndGrants);
    window.addEventListener("harness-access-changed", refreshAccessOnly);
    return () => {
      identitySeq.current += 1;
      window.removeEventListener("harness-auth-changed", refreshAuthAndGrants);
      window.removeEventListener("harness-auth-signed-in", refreshAuthAndGrants);
      window.removeEventListener("harness-access-changed", refreshAccessOnly);
    };
  }, [auth, repoId, rootDir]);

  const prevViewRef = useRef<string | undefined>(view);
  useEffect(() => {
    const prevView = prevViewRef.current;
    prevViewRef.current = view;
    if (view !== prevView && (prevView === "identityAccess" || view === "collaboration")) {
      setAuthEpoch((epoch) => epoch + 1);
    }
  }, [view]);

  const rawPersonId = identity?.phase === "ready" && identity.authenticated ? identity.personId : null;
  const currentPersonId = rawPersonId && rawPersonId.trim() !== "" ? rawPersonId : null;

  const [adminState, setAdminState] = useState(EMPTY_ADMIN_STATE);
  const adminSeq = useRef(0);
  const lastAuthContextRef = useRef<string>("");

  useEffect(() => {
    const contextKey = `${repoId ?? ""}\0${currentPersonId ?? ""}`;
    if (!currentPersonId || !repoId || lastAuthContextRef.current !== contextKey) {
      setAdminState(EMPTY_ADMIN_STATE);
    }
    lastAuthContextRef.current = contextKey;
    if (!currentPersonId || !repoId) return;
    const seq = ++adminSeq.current;
    void (async () => {
      const [explainReply, fleetEffectiveReply, grantsReply] = await Promise.all([
        explainRepoPersonActions(repoId, currentPersonId).catch(() => null),
        access && typeof access.effectivePermissions === "function"
          ? access.effectivePermissions({ personId: currentPersonId, resource: "@fleet" }).catch(() => null)
          : Promise.resolve(null),
        access && typeof access.grants === "function" ? access.grants().catch(() => null) : Promise.resolve(null),
      ]);
      if (adminSeq.current !== seq) return;
      const isRepoAdmin = evaluateRepoAdminFromExplain(currentPersonId, explainReply);
      const canManageFleetNodes = evaluateFleetNodeAdminAccess(fleetEffectiveReply);
      const { memberPeople, allPeople } = filterRepoKnownMembers(repoId, grantsReply);
      setAdminState({
        isRepoAdmin,
        canManageFleetNodes,
        memberPeople: isRepoAdmin ? memberPeople : [],
        allPeople,
      });
    })();
    return () => {
      adminSeq.current += 1;
    };
  }, [access, authEpoch, currentPersonId, repoId]);

  const peopleById = useMemo(
    () => new Map(adminState.allPeople.map((person) => [person.personId, person.username] as const)),
    [adminState.allPeople],
  );

  const nodeOwners = useMemo(() => {
    const owners = new Map<string, string>();
    for (const node of fleetNodes) {
      if (
        node.role === "edge" &&
        node.owner.kind === "value" &&
        node.owner.text !== "" &&
        node.owner.text !== "not-in-registry" &&
        node.owner.text !== "daemon"
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
        knownMembers: adminState.memberPeople.map((person) => ({
          personId: person.personId,
          label: person.username || personShortName(person.personId),
        })),
        extraPersonIds: [...nodeOwners.values()],
        currentPersonId,
        peopleById,
      }),
    [tasks, adminState.memberPeople, nodeOwners, currentPersonId, peopleById],
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
    adminState.isRepoAdmin && currentPersonId !== null && (memberOptions.length >= 2 || hasExternalNodes);

  const [scopePersonId, setScopePersonId] = useState<string | null>(null);
  useEffect(() => {
    setScopePersonId(null);
  }, [repoId, currentPersonId]);
  useEffect(() => {
    if (!canUseGlobalLens) setScopePersonId(null);
  }, [canUseGlobalLens]);

  return {
    currentPersonId,
    isAdmin: adminState.isRepoAdmin,
    canManageFleetNodes: adminState.canManageFleetNodes,
    canUseGlobalLens,
    scopePersonId,
    setScopePersonId,
    memberOptions,
    nodeOptions,
    peopleById,
    nodeOwners,
  };
}
