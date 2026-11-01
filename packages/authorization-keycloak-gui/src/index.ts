import { createAccessParts } from "./AccessParts.js";
import { createAccessServiceTab } from "./AccessServiceTab.js";
import { createActionDetails } from "./ActionDetails.js";
import { createDevicesTab } from "./DevicesTab.js";
import { createGrantsTab } from "./GrantsTab.js";
import { createGroupScopePreview } from "./GroupScopePreview.js";
import { createPermissionRequestsTab } from "./PermissionRequestsTab.js";
import { createPolicyGroupsTab } from "./PolicyGroupsTab.js";
import { createReceiptsTab } from "./ReceiptsTab.js";
import { createTeamsTab } from "./TeamsTab.js";
import { createAccessModel } from "./access-model.js";
import type { KeycloakUiHost } from "./ui-host.js";
import type { ComponentType } from "react";
import type {
  AccessAction,
  AccessAdminApi,
  AccessPolicyGroup,
  AccessReceipt,
  AccessRejection,
} from "@harness-anything/authorization-gui/access-admin-contract";
import type { OidcAuthApi } from "@harness-anything/authorization-gui/oidc-auth-contract";
import type { AccessScope } from "./access-model.js";
export type { KeycloakUiHost } from "./ui-host.js";
export type { AccessScope } from "./access-model.js";
export interface AuthorizationKeycloakUi {
  readonly INPUT: string;
  readonly asRejection: (error: unknown) => AccessRejection;
  readonly useAccessRead: <T>(read: (() => Promise<({ readonly ok: true } & T) | AccessRejection>) | undefined) => {
    readonly data: T | null;
    readonly rejection: AccessRejection | null;
    readonly reload: () => Promise<T | null>;
  };
  readonly AccessNotice: ComponentType<{
    readonly rejection: AccessRejection;
    readonly origin: "read" | "write";
    readonly testId?: string;
  }>;
  readonly ReceiptRows: ComponentType<{
    readonly receipts: readonly AccessReceipt[];
    readonly busy: boolean;
    readonly onReconcile?: (operationId: string) => void;
  }>;
  readonly AccessServiceTab: ComponentType<{
    readonly auth: OidcAuthApi;
    readonly access: AccessAdminApi | undefined;
    readonly repoId?: string;
    readonly rootDir?: string;
    readonly repoMode?: "local" | "remote-proxy" | "remote-center" | "remote-edge";
  }>;
  readonly DevicesTab: ComponentType<{ readonly access: AccessAdminApi }>;
  readonly GrantsTab: ComponentType<{
    readonly access: AccessAdminApi;
    readonly repos: readonly { readonly repoId: string; readonly displayName: string }[];
  }>;
  readonly GroupScopePreview: ComponentType<{
    readonly group: AccessPolicyGroup;
    readonly groups: readonly AccessPolicyGroup[];
    readonly actions: readonly AccessAction[];
  }>;
  readonly PermissionRequestsTab: ComponentType<{ readonly access: AccessAdminApi; readonly identity: string }>;
  readonly PolicyGroupsTab: ComponentType<{ readonly access: AccessAdminApi }>;
  readonly ReceiptsTab: ComponentType<{ readonly access: AccessAdminApi }>;
  readonly TeamsTab: ComponentType<{ readonly access: AccessAdminApi }>;
  readonly ActionDetails: ComponentType<{ readonly actions: readonly AccessAction[]; readonly grouped?: boolean }>;
  readonly inheritedScopes: (groups: readonly AccessPolicyGroup[], composites: Iterable<string>) => ReadonlySet<string>;
  readonly resourceOfScope: (scope: AccessScope) => string | null;
  readonly scopeOfResource: (resource: string) => AccessScope;
  readonly resourceLabel: (resource: string) => string;
  readonly rejectionText: (rejection: AccessRejection) => string;
  readonly receiptTitle: (receipt: AccessReceipt) => string;
  readonly isRejection: (reply: { readonly ok: boolean }) => reply is AccessRejection;
  readonly isPermissionRefusal: (rejection: AccessRejection) => boolean;
  readonly grantsByPerson: (
    people: readonly { readonly personId: string; readonly username: string }[],
    grants: readonly import("@harness-anything/authorization-gui/access-admin-contract").AccessGrant[],
    repoId?: string,
  ) => readonly {
    readonly personId: string;
    readonly username: string;
    readonly grants: readonly import("@harness-anything/authorization-gui/access-admin-contract").AccessGrant[];
  }[];
  readonly roleLabel: (id: string, displayName?: string) => string;
  readonly sessionDuration: (seconds: number) => string;
}
/** Create independent components using the embedding shell design system. No global registration. */
export function createKeycloakUi(host: KeycloakUiHost): AuthorizationKeycloakUi {
  return {
    ...createAccessParts(host),
    ...createAccessServiceTab(host),
    ...createActionDetails(host),
    ...createDevicesTab(host),
    ...createGrantsTab(host),
    ...createGroupScopePreview(host),
    ...createPermissionRequestsTab(host),
    ...createPolicyGroupsTab(host),
    ...createReceiptsTab(host),
    ...createTeamsTab(host),
    ...createAccessModel(host),
  };
}
