import { useEffect, useMemo, useRef, useState } from "react";
import type { RepositoryMembersReply } from "@harness-anything/authorization-gui/access-admin-contract";
import { consumeKnownError } from "../api/error-consumption.ts";
import type { FleetOverviewNode } from "../api/renderer-dto.ts";
import { guiHostBridge } from "./gui-transport.ts";
import { readIdentity, type IdentitySnapshot } from "./identity-session.ts";
import {
  collectMemberOptions,
  collectNodeOptions,
  primaryTaskNodeId,
  type MemberOption,
  type NodeOption,
} from "./model/attribution.ts";
import type { TaskRow } from "./model/types.ts";
import { t } from "./i18n/index.tsx";

export interface MemberScopeContext {
  readonly identityPending: boolean;
  readonly currentPersonId: string | null;
  readonly canManageFleetNodes: boolean;
  readonly canUseGlobalLens: boolean;
  readonly scopePersonId: string | null;
  readonly selectedPersonId: string | null | undefined;
  readonly setScopePersonId: (personId: string | null) => void;
  readonly lensMembers: readonly MemberOption[];
  readonly memberOptions: readonly MemberOption[];
  readonly nodeOptions: readonly NodeOption[];
  readonly peopleById: ReadonlyMap<string, string>;
  readonly nodeOwners: ReadonlyMap<string, string>;
}

const EMPTY_NODES: readonly FleetOverviewNode[] = [];
const EMPTY_MEMBERS: RepositoryMembersReply["members"] = [];
const EMPTY_LENS_MEMBERS: readonly MemberOption[] = [];

export function useMemberScopeContext(input: {
  readonly repoId: string | null;
  readonly rootDir: string | undefined;
  readonly tasks: readonly TaskRow[];
  readonly fleetNodes?: readonly FleetOverviewNode[];
  readonly collaborative?: boolean;
  readonly view?: string;
}): MemberScopeContext {
  const { repoId, rootDir, tasks, fleetNodes = EMPTY_NODES, collaborative, view } = input;
  const bridge = guiHostBridge();
  const auth = bridge?.auth && typeof bridge.auth.status === "function" ? bridge.auth : undefined;
  const access = useMemo(
    () =>
      repoId && typeof bridge?.access?.forRepository === "function" ? bridge.access.forRepository(repoId) : undefined,
    [bridge?.access, repoId],
  );

  const identityKey = JSON.stringify([repoId, rootDir]);
  const [identity, setIdentity] = useState<{ key: string; snapshot: IdentitySnapshot } | null>(null);
  const [authEpoch, setAuthEpoch] = useState(0);
  const identitySeq = useRef(0);
  useEffect(() => {
    setIdentity(null);
    if (!auth) return;
    const refreshIdentity = () => {
      const seq = ++identitySeq.current;
      void readIdentity(auth, repoId ?? undefined, rootDir).then((snapshot) => {
        if (identitySeq.current !== seq) return;
        setIdentity({ key: identityKey, snapshot });
      });
    };
    const refreshAuthAndGrants = () => {
      setIdentity(null);
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
  }, [auth, identityKey, repoId, rootDir]);

  const prevViewRef = useRef<string | undefined>(view);
  useEffect(() => {
    const prevView = prevViewRef.current;
    prevViewRef.current = view;
    if (view !== prevView && (prevView === "identityAccess" || view === "collaboration")) {
      setAuthEpoch((epoch) => epoch + 1);
    }
  }, [view]);

  const snapshot = identity?.key === identityKey ? identity.snapshot : null;
  const currentPersonId =
    snapshot?.phase === "ready" && snapshot.authenticated ? snapshot.personId?.trim() || null : null;
  const accessKey = JSON.stringify([identityKey, currentPersonId, authEpoch]);
  const [accessRead, setAccessRead] = useState<{ key: string; reply: RepositoryMembersReply } | null>(null);

  useEffect(() => {
    if (currentPersonId === null || typeof access?.repositoryMembers !== "function") return;
    let current = true;
    void access
      .repositoryMembers()
      .then((reply) => {
        if (current && reply.ok === true && reply.personId === currentPersonId)
          setAccessRead({ key: accessKey, reply });
      })
      .catch(consumeKnownError);
    return () => {
      current = false;
    };
  }, [access, accessKey, currentPersonId]);

  // An access refresh changes the key in the render that handles the event, before effects or RPCs settle.
  const adminState = accessRead?.key === accessKey ? accessRead.reply : null;
  const memberPeople = adminState?.members ?? EMPTY_MEMBERS;
  const peopleById = useMemo(
    () => new Map(memberPeople.map((person) => [person.personId, person.username] as const)),
    [memberPeople],
  );
  const lensMembers = useMemo(
    () =>
      collectMemberOptions({
        knownMembers: memberPeople.map((person) => ({ personId: person.personId, label: person.username })),
        currentPersonId,
        peopleById,
      }),
    [memberPeople, currentPersonId, peopleById],
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
        knownMembers: lensMembers,
        extraPersonIds: [...nodeOwners.values()],
        currentPersonId,
        peopleById,
      }),
    [tasks, lensMembers, nodeOwners, currentPersonId, peopleById],
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

  const canUseGlobalLens = currentPersonId !== null && (collaborative || lensMembers.length >= 2 || hasExternalNodes);
  const allowedMembers = adminState?.isRepoAdmin === true ? lensMembers : EMPTY_LENS_MEMBERS;
  const [selection, setSelection] = useState<{ key: string; personId: string | null } | null>(null);
  const selected = selection?.key === accessKey ? selection : null;
  const defaultScope = view === "overview" || view === "todos" ? currentPersonId : null;
  const selectedPersonId = canUseGlobalLens ? selected?.personId : undefined;
  const scopePersonId = canUseGlobalLens && selectedPersonId === undefined ? defaultScope : (selectedPersonId ?? null);

  return {
    identityPending: auth !== undefined && snapshot === null,
    currentPersonId,
    canManageFleetNodes: adminState?.canManageFleetNodes === true,
    canUseGlobalLens,
    scopePersonId,
    selectedPersonId,
    setScopePersonId: (personId) => {
      if (
        personId === null ||
        personId === currentPersonId ||
        allowedMembers.some((member) => member.personId === personId)
      )
        setSelection({ key: accessKey, personId });
    },
    lensMembers: allowedMembers,
    memberOptions,
    nodeOptions,
    peopleById,
    nodeOwners,
  };
}
