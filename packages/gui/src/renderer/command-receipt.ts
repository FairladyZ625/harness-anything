import type { GuiActionResult } from "../api/renderer-dto.ts";
import { localErrorHint } from "./result-validation.ts";

export function readGuiActionResult(value: unknown): GuiActionResult {
  const result = value as Partial<GuiActionResult>;
  if (
    !result ||
    result.schema !== "command-receipt/v2" ||
    typeof result.ok !== "boolean" ||
    typeof result.command !== "string" ||
    !["applied", "pending", "no_changes", "indeterminate", "op_rejected"].includes(String(result.outcome)) ||
    typeof result.opId !== "string"
  ) {
    throw new Error(localErrorHint(value, "GUI action bridge returned an invalid receipt."));
  }
  return result as GuiActionResult;
}

/**
 * GUI 写后落定协议。
 *
 * daemon 已经实现了 receipt 落定谓词(kernel `waitForReceiptAcceptance`),`ha` 的每一次写
 * 都用它等 follower 追平(见 `packages/cli/src/daemon/command-visibility.ts`)。写回执本身是
 * follower 发布之前那一瞬的快照,`git`/`worktree` 必然还是 pending;没有这次有界等待,renderer
 * 看到的永远是「已接受但不可见」,于是每次写入都停在 `pending · canonical_not_visible`。
 *
 * 这里只做一次**只读**的 canonical receipt 查询——不在 renderer 里轮询,也不重放 mutation。
 */
export const RECEIPT_SETTLE_WAIT = ["projection_visible", "git_verified", "worktree_visible"] as const,
  RECEIPT_SETTLE_TIMEOUT_MS = 5_000,
  // 只有验收面从落定读回执覆盖回来;命令自带的字段(path/documentSha256/consentId…)原样保留。
  RECEIPT_SETTLEMENT_FIELDS = [
    "outcome",
    "status",
    "acceptance",
    "projection",
    "git",
    "worktree",
    "replica",
    "wait",
    "proof",
    "cut",
    "commitSha",
    "canonicalVisible",
    "worktreeVisible",
    "revision",
  ] as const;

export type ReceiptRead = (payload: {
  readonly repoId: string;
  readonly opId: string;
  readonly waitFor?: readonly string[];
  readonly timeoutMs?: number;
}) => Promise<GuiActionResult>;

type SettlingReceipt = GuiActionResult & {
  readonly status?: string;
  readonly proof?: { readonly canonicalVisible?: boolean; readonly worktreeVisible?: boolean | null };
};

export async function settleWriteReceipt(
  repoId: string,
  receipt: GuiActionResult,
  showReceipt: ReceiptRead,
): Promise<GuiActionResult> {
  const written = receipt as SettlingReceipt;
  // 只有 canonical 已经接受的写才等落定。真正未知/indeterminate/被拒的操作原样交回,
  // 调用方照旧按 pending 或 op_rejected 处理——落定等待不能把未知说成成功。
  if (written.status !== "accepted_durable") return receipt;
  if (
    written.outcome === "applied" &&
    written.proof?.canonicalVisible === true &&
    written.proof.worktreeVisible === true
  )
    return receipt;
  const observed = (await showReceipt({
    repoId,
    opId: written.opId,
    waitFor: RECEIPT_SETTLE_WAIT,
    timeoutMs: RECEIPT_SETTLE_TIMEOUT_MS,
  })) as SettlingReceipt;
  // 观察到的必须是同一次接受;否则保留原回执,让调用方按未落定处理。
  if (observed.status !== "accepted_durable" || observed.opId !== written.opId) return receipt;
  return {
    ...receipt,
    ...Object.fromEntries(
      RECEIPT_SETTLEMENT_FIELDS.filter((field) => Object.hasOwn(observed, field)).map((field) => [
        field,
        (observed as unknown as Record<string, unknown>)[field],
      ]),
    ),
  } as GuiActionResult;
}
