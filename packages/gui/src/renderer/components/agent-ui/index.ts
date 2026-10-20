/**
 * agent-ui 原语库 barrel(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2):
 * 审批/收件箱/工具调用/差异批注四类人机协同与工具可观测原语。
 * W2/W3 各核心面从这里接入;组件自包含、props 驱动,不反向依赖视图层。
 */
export { ApprovalCard, type ApprovalDecision, type ApprovalRisk, type ApprovalVerdict } from "./ApprovalCard.tsx";
export {
  AgentInbox,
  type InboxActionKind,
  type InboxItem,
  type InboxItemAction,
  type InboxLane,
} from "./AgentInbox.tsx";
export {
  DEFAULT_PAYLOAD_PREVIEW_LIMIT,
  ToolCallCard,
  ToolCallGroup,
  truncatePayload,
  type PayloadPreview,
  type ToolCall,
  type ToolCallStatus,
} from "./ToolCallCard.tsx";
export {
  AnnotateDiffViewer,
  formatBatchReviewPrompt,
  type DiffAnnotation,
  type DiffFile,
  type DiffLine,
  type DiffLineKind,
  type DiffViewMode,
} from "./AnnotateDiffViewer.tsx";
