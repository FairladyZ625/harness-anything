// 运行时 model 字段的显示解析。声明 schema 要求 model 是非空字符串,但会话型运行时
// (deepseek-harness)按约定把候选模型清单以 JSON 数组文本原样写入 model——字符串合法,
// 直接渲染却是一长串机器文本,把列表行的名称列挤没。这里是唯一的解析点:列表行的
// 短标签、行悬停全文与详情页的完整候选清单都从同一份结果派生,不保留整串渲染路径。
import { consumeKnownError } from "../../api/error-consumption.ts";

/** model 字符串是候选清单(JSON 数组文本)时返回逐项候选;普通模型名返回 null。 */
export function runtimeModelCandidates(model: string | null | undefined): readonly string[] | null {
  if (typeof model !== "string" || !model.trim().startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(model);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((item) => typeof item === "string" && item.trim() !== "")) return null;
    return parsed.map((item) => item.trim());
  } catch (error) {
    // 解析失败就是「不是候选清单」这一答案本身,不是要上抛的故障。
    consumeKnownError(error);
    return null;
  }
}

/** 列表行的右栏短标签:候选清单显示第一个候选加「+N」;普通模型名原样。 */
export function runtimeModelShortLabel(model: string | null | undefined): string | null {
  const candidates = runtimeModelCandidates(model);
  if (candidates === null) return typeof model === "string" && model !== "" ? model : null;
  return candidates.length === 1 ? candidates[0]! : `${candidates[0]!} +${candidates.length - 1}`;
}

/** 悬停/详情的完整读法:候选清单逐项以「 / 」连接;普通模型名原样。 */
export function runtimeModelFullLabel(model: string | null | undefined): string | null {
  const candidates = runtimeModelCandidates(model);
  return candidates === null ? runtimeModelShortLabel(model) : candidates.join(" / ");
}
