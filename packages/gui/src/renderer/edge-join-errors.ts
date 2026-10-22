import { t, type MessageKey } from "./i18n/index.tsx";

/** daemon 错误码 → 一句人话 + 下一步;未映射的码原样显示 daemon 的说明。 */
const explanations: Readonly<Record<string, { readonly message: MessageKey; readonly next: MessageKey }>> = {
  center_address_unreachable: {
    message: "views.edgeJoin.error.center_address_unreachable.message",
    next: "views.edgeJoin.error.center_address_unreachable.next",
  },
  login_address_unreachable: {
    message: "views.edgeJoin.error.login_address_unreachable.message",
    next: "views.edgeJoin.error.login_address_unreachable.next",
  },
  edge_join_addresses_unreachable: {
    message: "views.edgeJoin.error.edge_join_addresses_unreachable.message",
    next: "views.edgeJoin.error.edge_join_addresses_unreachable.next",
  },
  edge_join_invalid: {
    message: "views.edgeJoin.error.edge_join_invalid.message",
    next: "views.edgeJoin.error.edge_join_invalid.next",
  },
  join_token_expired: {
    message: "views.edgeJoin.error.join_token_expired.message",
    next: "views.edgeJoin.error.join_token_expired.next",
  },
  already_consumed: {
    message: "views.edgeJoin.error.already_consumed.message",
    next: "views.edgeJoin.error.already_consumed.next",
  },
  join_revoked: {
    message: "views.edgeJoin.error.join_revoked.message",
    next: "views.edgeJoin.error.join_revoked.next",
  },
  pin_mismatch: {
    message: "views.edgeJoin.error.pin_mismatch.message",
    next: "views.edgeJoin.error.pin_mismatch.next",
  },
  person_mismatch: {
    message: "views.edgeJoin.error.person_mismatch.message",
    next: "views.edgeJoin.error.person_mismatch.next",
  },
  permission_snapshot_changed: {
    message: "views.edgeJoin.error.permission_snapshot_changed.message",
    next: "views.edgeJoin.error.permission_snapshot_changed.next",
  },
  protocol_version_unsupported: {
    message: "views.edgeJoin.error.protocol_version_unsupported.message",
    next: "views.edgeJoin.error.protocol_version_unsupported.next",
  },
  oidc_device_expired: {
    message: "views.edgeJoin.error.oidc_device_expired.message",
    next: "views.edgeJoin.error.oidc_device_expired.next",
  },
  oidc_device_transport_unavailable: {
    message: "views.edgeJoin.error.oidc_device_transport_unavailable.message",
    next: "views.edgeJoin.error.oidc_device_transport_unavailable.next",
  },
  oidc_device_rejected: {
    message: "views.edgeJoin.error.oidc_device_rejected.message",
    next: "views.edgeJoin.error.oidc_device_rejected.next",
  },
};

export interface EdgeJoinFailureView {
  readonly message: string;
  readonly next: string | null;
}

export function explainEdgeJoinFailure(failure: {
  readonly code?: string;
  readonly explanation?: string;
}): EdgeJoinFailureView {
  const mapped = failure.code === undefined ? undefined : explanations[failure.code];
  if (mapped) return { message: t(mapped.message), next: t(mapped.next) };
  const raw = failure.explanation?.trim();
  return {
    message: raw !== undefined && raw !== "" ? raw : t("views.edgeJoin.error.fallback.message"),
    next: null,
  };
}
