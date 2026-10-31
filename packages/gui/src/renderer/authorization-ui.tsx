import { createKeycloakUi, type AuthorizationKeycloakUi } from "@harness-anything/authorization-keycloak-gui";
import { t, type MessageKey } from "./i18n/index.tsx";
import { formatTime } from "./model/time.ts";
import { Button } from "./components/primitives/Button.tsx";
import { DenseRow } from "./components/primitives/DenseRow.tsx";
import { StatusTag } from "./components/primitives/StatusTag.tsx";
import { BrowserView } from "./views/BrowserView.tsx";
import { Region } from "./components/primitives/Region.tsx";
import { BoardColumn } from "./components/primitives/RegionBoard.tsx";
import { BoardMain } from "./components/primitives/RegionBoard.tsx";
import { BoardRegion } from "./components/primitives/RegionBoard.tsx";
import { BoardSide } from "./components/primitives/RegionBoard.tsx";
import { RegionBoard } from "./components/primitives/RegionBoard.tsx";
import { currentLocale } from "./i18n/core.ts";
import { BoundedContent } from "./components/primitives/BoundedContent.tsx";
import { IdText } from "./components/IdText.tsx";
import { Modal } from "./components/primitives/Modal.tsx";
import { RecordRow } from "./components/primitives/RecordRow.tsx";
import { SegCtl } from "./components/primitives/SegCtl.tsx";
export const keycloakUi: AuthorizationKeycloakUi = createKeycloakUi({
  formatTime: (value, options) => formatTime(String(value), { style: options?.style ?? "date-time" }),
  Button,
  DenseRow,
  StatusTag,
  BrowserView,
  Region,
  BoardColumn,
  BoardMain,
  BoardRegion,
  BoardSide,
  RegionBoard,
  currentLocale,
  BoundedContent,
  IdText,
  Modal,
  RecordRow,
  SegCtl,
  t: (key: string, values?: Readonly<Record<string, string | number>>) => t(key as MessageKey, values),
});
export const {
  INPUT,
  asRejection,
  useAccessRead,
  AccessNotice,
  ReceiptRows,
  AccessServiceTab,
  ActionDetails,
  DevicesTab,
  GrantsTab,
  GroupScopePreview,
  PermissionRequestsTab,
  PolicyGroupsTab,
  ReceiptsTab,
  TeamsTab,
  inheritedScopes,
  resourceOfScope,
  scopeOfResource,
  resourceLabel,
  rejectionText,
  receiptTitle,
  isRejection,
  isPermissionRefusal,
  grantsByPerson,
  roleLabel,
  sessionDuration,
} = keycloakUi;
export type { AccessScope } from "@harness-anything/authorization-keycloak-gui";
