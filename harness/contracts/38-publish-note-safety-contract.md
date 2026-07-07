# Publish Note Safety Contract

- **状态**: skeleton — 未成文（结构就位，规则集待填充与裁决）
- **日期**: 2026-06-12
- **效力**: 本合同未从 skeleton 升级为 canonical 之前，**任何 publishNote 实现不得调用外部 comment API**（25-blocker-decision-checklist §3）。M2 publishNote packet、PLT-Adapter G-09（GitHub）、L-08（Linear）均以本合同 canonical 化为 entry gate。

---

## 1. 范围

约束所有经 `LifecycleEngine.publishNote` 向外部引擎（Multica / GitHub / Linear）追加评论的写路径。这是 adapter 体系中唯一允许的外部写操作，且必须满足本合同全部规则后方可执行。

## 2. Secret Patterns（待填充）

> 待定：正则清单 + 扫描时机（序列化后、发送前）。

- [ ] API key / token 模式（如 `ghp_*`、`lin_api_*`、AWS key 等）
- [ ] 私钥块（`-----BEGIN ... PRIVATE KEY-----`）
- [ ] 环境变量赋值形态（`XXX_TOKEN=...`）
- [ ] 命中即阻断发送（不脱敏后继续），记录 audit event

## 3. Private Path Allow/Deny List（待填充）

> 待定：与 09-boundaries-deletions §3 public/private 边界表对齐。

- [ ] deny：本机绝对路径（`/Users/...`、`C:\...`）
- [ ] deny：`harness/**` 任何路径片段
- [ ] deny：workspace/project UUID、外部引擎内部 ID 原文
- [ ] allow：repo 相对路径（待定是否需要白名单形态）

## 4. Summary Length Budget（待填充）

- [ ] 单条评论长度上限（按 provider 取 min，见 §6）
- [ ] 超限策略：截断 + 指向 local 产物链接，不分页连发
- [ ] 禁止发送完整 walkthrough（25 §4 Red Flag）

## 5. Link Kinds Allowlist（待填充）

- [ ] 允许的链接类型清单（如 commit URL / PR URL / 公开 repo 文件 URL）
- [ ] 禁止 `file://`、本机端口、内网地址

## 6. Provider-Specific Constraints（待填充）

| Provider | 评论长度上限 | 格式约束 | 备注 |
|----------|-------------|----------|------|
| GitHub Issues | 待定 | Markdown | 32 §7.5 |
| Linear | 待定 | Markdown（GraphQL `commentCreate`） | 33 §7.4 |
| Multica | 待定 | 待定 | M2 只读，publishNote 是否对 Multica 开放待裁决 |

## 7. Idempotency Storage（待填充）

- [ ] idempotencyKey 生成规则（与 G-ND-2 / L-ND-2 评论 marker 格式一并锁定）
- [ ] 自发评论 marker 格式（机器可识别、防伪、不可与人工评论混淆）
- [ ] 查重存储位置（本地 journal vs 远端评论扫描，或两者结合）

## 8. Retry / Backoff（待填充）

- [ ] 网络失败重试策略（次数 / 退避曲线）
- [ ] rate_limit 响应处理（遵守 provider Retry-After）
- [ ] 重试前必须复核幂等（防止重试产生重复评论）

## 9. Audit Event Fields（待填充）

- [ ] 每次 publishNote 尝试记录：target ref / idempotencyKey / 内容 hash / redaction 扫描结果 / 发送结果
- [ ] 阻断事件（secret / private path 命中）单独记录命中规则 ID，不记录命中内容原文

## 10. 测试要求（待填充）

- [ ] redaction 夹具：每条 deny 规则至少一个命中夹具，全拦
- [ ] 幂等夹具：同 key 重试不产生第二条评论
- [ ] 长度夹具：超限内容被截断且含链接

---

## Canonical 化前置

1. §2/§3/§5 规则清单经裁决锁定；
2. §7 marker 格式与 G-ND-2 / L-ND-2 同步锁定；
3. §10 测试夹具齐备；
4. 经 review protocol（28）走一次 arch-review。
