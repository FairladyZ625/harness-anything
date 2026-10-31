/** Presentation is declared beside the action; policy evaluation does not consume it. */
export const actionPresentation = {
  "todo-add": { domain: "todo", name: "添加待办", description: "记录一句话待办。" },
  "todo-done": { domain: "todo", name: "完成待办", description: "勾选完成并收起。" },
  "todo-archive": { domain: "todo", name: "归档待办", description: "将待办收纳到归档。" },
  "todo-reopen": { domain: "todo", name: "找回待办", description: "恢复到未完成清单。" },
  "todo-relate": { domain: "todo", name: "关联待办", description: "为待办添加可选关系。" },
  "todo-promote": { domain: "todo", name: "升级待办", description: "创建任务并关联原待办。" },

  "repository-read": { domain: "repository", name: "读取仓库", description: "查看获授权仓库中的内容。" },
  "agent-assign": { domain: "agent", name: "指派代理", description: "将代理配置指派给人员、工作组或节点。" },
  "agent-unassign": { domain: "agent", name: "取消代理指派", description: "解除代理配置的当前指派。" },
  "assignment-migrate": { domain: "migrate", name: "迁移指派", description: "将历史任务指派迁移为统一 Relation。" },
  "agent-delete": { domain: "agent", name: "删除代理", description: "删除已登记的代理配置。" },
  "agent-retire": { domain: "agent", name: "停用代理", description: "停止继续使用已登记的代理。" },
  "agent-install": { domain: "agent", name: "安装代理", description: "将代理定义安装到仓库。" },
  "agent-run": { domain: "agent", name: "运行代理", description: "在运行主机启动代理。" },
  "daemon-connection-add": { domain: "daemon", name: "添加连接", description: "登记与其他节点的连接。" },
  "daemon-connection-probe": { domain: "daemon", name: "检查连接", description: "检查已登记连接的可达情况。" },
  "daemon-connection-remove": { domain: "daemon", name: "移除连接", description: "移除已登记连接。" },
  "daemon-connection-update": { domain: "daemon", name: "修改连接", description: "更新已登记连接配置。" },
  "ledger-backup": { domain: "ledger", name: "备份台账", description: "创建台账的备份。" },
  "ledger-restore-drill": { domain: "ledger", name: "演练恢复", description: "验证台账备份的恢复流程。" },
  "daemon-control-request": { domain: "daemon", name: "请求节点控制", description: "向节点发出控制请求。" },
  "daemon-fleet-center-start": { domain: "daemon", name: "启动中心", description: "启用舰队中心服务。" },
  "daemon-fleet-edge-sync": { domain: "daemon", name: "同步边缘", description: "将边缘节点与中心同步。" },
  "daemon-repo-register": { domain: "daemon", name: "登记仓库", description: "将仓库登记到当前节点。" },
  "repo-purge": { domain: "repo", name: "清除仓库", description: "清除仓库的台账数据。" },
  "repo-unbind": { domain: "repo", name: "解绑仓库", description: "解除仓库与节点的绑定。" },
  "daemon-repo-update": { domain: "daemon", name: "更新仓库登记", description: "修改仓库登记资料。" },
  "daemon-service-install": { domain: "daemon", name: "安装后台服务", description: "安装节点后台服务。" },
  "daemon-service-uninstall": { domain: "daemon", name: "卸载后台服务", description: "卸载节点后台服务。" },
  "daemon-start": { domain: "daemon", name: "启动后台服务", description: "启动当前节点的后台服务。" },
  "daemon-stop": { domain: "daemon", name: "停止后台服务", description: "停止当前节点的后台服务。" },
  "decision-accept": { domain: "decision", name: "接受决策", description: "将决策确认为已接受。" },
  "decision-amend": { domain: "decision", name: "修订决策", description: "修改决策的声明内容。" },
  "decision-assign": { domain: "decision", name: "指派决策", description: "将决策指派给人员、工作组或节点。" },
  "decision-unassign": { domain: "decision", name: "取消决策指派", description: "解除决策的当前指派。" },
  "decision-claim-add": { domain: "decision", name: "声明履行项", description: "为决策登记需要履行的事项。" },
  "decision-claim-fulfill": { domain: "decision", name: "履行决策事项", description: "记录声明事项的履行结果。" },
  "decision-defer": { domain: "decision", name: "暂缓决策", description: "将决策延后处理。" },
  "decision-dispatch-review": { domain: "decision", name: "派发决策审查", description: "请求独立审查决策。" },
  "decision-propose": { domain: "decision", name: "提出决策", description: "创建供裁定的决策提案。" },
  "decision-reckon": { domain: "decision", name: "核对决策履行", description: "核对决策的声明与履行证据。" },
  "decision-reject": { domain: "decision", name: "否决决策", description: "裁定不接受决策提案。" },
  "decision-rematerialize": {
    domain: "decision",
    name: "重新生成决策文档",
    description: "从中心已接受内容重新生成本地文档。",
  },
  "decision-repin": { domain: "decision", name: "更新决策引用", description: "将决策引用固定到指定版本。" },
  "decision-review": { domain: "decision", name: "审查决策", description: "提交对决策的独立审查意见。" },
  "decision-respond-review": { domain: "decision", name: "回应决策审查", description: "回应决策审查中提出的问题。" },
  "decision-override-review": { domain: "decision", name: "裁定审查异议", description: "对决策审查异议作出裁定。" },
  "decision-retire": { domain: "decision", name: "退役决策", description: "结束决策的现行效力。" },
  "decision-transition": { domain: "decision", name: "推进决策状态", description: "执行决策生命周期的状态转换。" },
  "distill-candidate": { domain: "distill", name: "提炼候选", description: "从已有资料提炼知识候选。" },
  "distill-promote": { domain: "distill", name: "晋升提炼结果", description: "将知识候选晋升为正式记录。" },
  "doc-conflict-discard-local": { domain: "doc", name: "放弃本地冲突内容", description: "丢弃冲突中的本地文档改动。" },
  "doc-conflict-overwrite-center": {
    domain: "doc",
    name: "提交本地冲突内容",
    description: "以本地内容解决与中心文档的冲突。",
  },
  "doc-conflict-resolve": { domain: "doc", name: "解决文档冲突", description: "提交文档冲突的处理结果。" },
  "doc-materialize": { domain: "doc", name: "生成本地文档", description: "将中心文档生成到本地工作区。" },
  "doc-retire": { domain: "doc", name: "退役文档", description: "结束文档的现行用途。" },
  "doc-submit": { domain: "doc", name: "提交文档", description: "将本地文档提交到中心。" },
  "entity-archive": { domain: "entity", name: "归档对象", description: "将对象移入归档。" },
  "entity-delete": { domain: "entity", name: "删除对象", description: "删除指定业务对象。" },
  "entity-import": { domain: "entity", name: "导入对象", description: "将已有资料导入为业务对象。" },
  "entity-pin": { domain: "entity", name: "固定对象引用", description: "固定对象所引用的资料版本。" },
  "entity-unpin": { domain: "entity", name: "取消固定引用", description: "解除对象资料的版本固定。" },
  "entity-update": { domain: "entity", name: "修改对象", description: "更新指定业务对象的内容。" },
  "fact-archive": { domain: "fact", name: "归档事实", description: "将事实记录移入归档。" },
  "fact-assign": { domain: "fact", name: "指派事实", description: "将事实指派给人员、工作组或节点。" },
  "fact-unassign": { domain: "fact", name: "取消事实指派", description: "解除事实的当前指派。" },
  "fact-unarchive": { domain: "fact", name: "恢复归档事实", description: "使归档事实重新出现在现行列表。" },
  "fact-reclassify": { domain: "fact", name: "调整事实分类", description: "修改事实的分类。" },
  "fact-record": { domain: "fact", name: "记录事实", description: "创建可复核的观察记录。" },
  "fact-rematerialize": { domain: "fact", name: "重新生成事实文档", description: "从中心已接受内容重新生成事实文档。" },
  "fact-type-register": { domain: "fact", name: "登记事实类型", description: "登记事实记录使用的类型。" },
  "migrate-import": { domain: "migrate", name: "迁移导入", description: "将既有数据迁移到当前台账。" },
  "people-delegate": { domain: "people", name: "委派人员权限", description: "登记人员间的权限委派。" },
  "people-revoke-delegation": { domain: "people", name: "撤销人员委派", description: "结束已经登记的人员权限委派。" },
  "permission-request-create": { domain: "access", name: "申请权限", description: "请求授予指定资源范围的动作权限。" },
  "permission-request-decide": {
    domain: "access",
    name: "批准或拒绝权限申请",
    description: "对指定版本的权限申请作出决定。",
  },
  "permission-request-withdraw": {
    domain: "access",
    name: "撤回权限申请",
    description: "撤回尚未处理的本人权限申请。",
  },
  "preset-install": { domain: "preset", name: "安装任务模板", description: "安装任务使用的预设模板。" },
  "preset-run-start": { domain: "preset", name: "启动模板流程", description: "开始执行模板定义的流程。" },
  "preset-seed": { domain: "preset", name: "播种任务模板", description: "将预设内容写入工作区。" },
  "preset-uninstall": { domain: "preset", name: "卸载任务模板", description: "移除已安装的预设模板。" },
  "preset-upgrade": { domain: "preset", name: "升级任务模板", description: "更新已安装模板的版本。" },
  "projection-rebuild": { domain: "projection", name: "重建投影", description: "从规范记录重新生成查询投影。" },
  "provider-create": { domain: "provider", name: "创建判断 Provider", description: "登记 Decisions API Provider。" },
  "provider-delete": { domain: "provider", name: "删除判断 Provider", description: "删除 Decisions API Provider。" },
  "provider-list": { domain: "provider", name: "列出判断 Provider", description: "查看本机 Decisions API Provider。" },
  "provider-probe": {
    domain: "provider",
    name: "探测判断 Provider",
    description: "检查 Decisions API Provider 的可达性。",
  },
  "provider-show": {
    domain: "provider",
    name: "查看判断 Provider",
    description: "查看一个已登记的 Decisions API Provider。",
  },
  "provider-update": {
    domain: "provider",
    name: "更新判断 Provider",
    description: "修改 Decisions API Provider 配置。",
  },
  "rbac-bootstrap": { domain: "rbac", name: "初始化访问控制", description: "初始化账号与权限管理服务。" },
  "relation-reconfirm": { domain: "relation", name: "重新确认关系", description: "确认关系仍然成立。" },
  "relation-relate": { domain: "relation", name: "建立关系", description: "在业务对象之间登记关系。" },
  "relation-unrelate": { domain: "relation", name: "结束关系", description: "结束业务对象之间的关系。" },
  "repo-bootstrap": { domain: "repo", name: "初始化仓库", description: "建立仓库的台账工作区。" },
  "runtime-batch": { domain: "runtime", name: "批量派发运行", description: "提交一批代理运行请求。" },
  "runtime-cancel": { domain: "runtime", name: "取消运行", description: "请求取消正在执行的代理运行。" },
  "runtime-steer": { domain: "runtime", name: "纠偏运行", description: "向正在执行的代理追加指令并续跑。" },
  "runtime-handoff-export": { domain: "runtime", name: "导出运行交接", description: "导出供接续执行的交接资料。" },
  "runtime-handoff-claim": { domain: "runtime", name: "领取运行交接", description: "领取交接资料并接续执行。" },
  "runtime-handoff-revoke": { domain: "runtime", name: "撤销运行交接", description: "结束交接资料的领取资格。" },
  "runtime-incident-dismiss": {
    domain: "runtime",
    name: "关闭事故回执",
    description: "以理由关闭一条确需人工处置的事故升级回执。",
  },
  "runtime-instance-create": { domain: "runtime", name: "创建运行实例", description: "登记代理运行实例。" },
  "runtime-instance-delete": { domain: "runtime", name: "删除运行实例", description: "删除代理运行实例的配置。" },
  "runtime-instance-hosting-credential-set": {
    domain: "runtime",
    name: "设置实例凭据",
    description: "为运行实例设置代码托管凭据。",
  },
  "runtime-instance-hosting-credential-unset": {
    domain: "runtime",
    name: "移除实例凭据",
    description: "移除运行实例的代码托管凭据。",
  },
  "runtime-instance-list": { domain: "runtime", name: "列出运行实例", description: "查询本机运行实例。" },
  "runtime-instance-login": { domain: "runtime", name: "登录运行实例", description: "完成运行实例的登录。" },
  "runtime-instance-logout": { domain: "runtime", name: "退出运行实例", description: "结束运行实例的登录会话。" },
  "runtime-instance-show": { domain: "runtime", name: "查看运行实例", description: "读取指定运行实例的详情。" },
  "runtime-instance-update": { domain: "runtime", name: "更新运行实例", description: "修改运行实例的配置。" },
  "runtime-run": { domain: "runtime", name: "派发代理运行", description: "请求代理执行一次任务。" },
  "runtime-spawn": { domain: "runtime", name: "创建运行进程", description: "启动代理运行进程。" },
  "schedule-claim": { domain: "schedule", name: "领取定时任务", description: "领取待执行的定时任务。" },
  "schedule-assign": { domain: "schedule", name: "指派定时任务", description: "将定时任务指派给人员、工作组或节点。" },
  "schedule-unassign": { domain: "schedule", name: "取消定时任务指派", description: "解除定时任务的当前指派。" },
  "schedule-create": { domain: "schedule", name: "创建定时任务", description: "登记按时间触发的任务。" },
  "schedule-delete": { domain: "schedule", name: "删除定时任务", description: "删除已登记的定时任务。" },
  "schedule-disable": { domain: "schedule", name: "停用定时任务", description: "暂停定时任务的触发。" },
  "schedule-dispatch-link": { domain: "schedule", name: "关联定时运行", description: "将定时任务与执行记录关联。" },
  "schedule-enable": { domain: "schedule", name: "启用定时任务", description: "恢复定时任务的触发。" },
  "schedule-missed": { domain: "schedule", name: "记录错过触发", description: "记录未能执行的定时触发。" },
  "schedule-run-now": { domain: "schedule", name: "立即执行定时任务", description: "立即触发一次定时任务。" },
  "schedule-settle": { domain: "schedule", name: "结算定时运行", description: "记录定时运行的结算结果。" },
  "schedule-update": { domain: "schedule", name: "修改定时任务", description: "更新定时任务的配置。" },
  "script-run": { domain: "script", name: "运行脚本", description: "执行已登记的脚本。" },
  "settings-update": { domain: "settings", name: "修改设置", description: "更新仓库的设置。" },
  "squad-cancel": { domain: "squad", name: "取消协作运行", description: "取消代理小组的协作运行。" },
  "squad-assign": { domain: "squad", name: "指派代理小组", description: "将代理小组指派给人员、工作组或节点。" },
  "squad-unassign": { domain: "squad", name: "取消代理小组指派", description: "解除代理小组的当前指派。" },
  "squad-delete": { domain: "squad", name: "删除代理小组", description: "删除代理小组配置。" },
  "squad-install": { domain: "squad", name: "安装代理小组", description: "安装代理小组定义。" },
  "squad-run": { domain: "squad", name: "运行代理小组", description: "派发代理小组协作执行。" },
  "task-assign": { domain: "task", name: "指派任务", description: "将任务指派给人员、工作组或节点。" },
  "task-unassign": { domain: "task", name: "取消任务指派", description: "解除任务的当前指派。" },
  "task-amend": { domain: "task", name: "修订任务", description: "修订任务的目标和合同。" },
  "task-annotate": { domain: "task", name: "添加任务注记", description: "为任务追加说明。" },
  "task-archive": { domain: "task", name: "归档任务", description: "将任务移入归档。" },
  "task-artifact-add": { domain: "task", name: "发布任务交付物", description: "将任务文件登记为交付物。" },
  "task-attest": { domain: "task", name: "确认任务证据", description: "记录任务证据的确认。" },
  "task-complete": { domain: "task", name: "完成任务", description: "在合同已满足后关闭任务。" },
  "task-witness-claim": { domain: "task", name: "认领门运行", description: "认领当前提交的一次完成门运行。" },
  "task-witness-settle": { domain: "task", name: "提交门结果", description: "登记已认领门运行的结果。" },
  "task-witness-revoke": { domain: "task", name: "撤销门运行", description: "撤销当前完成门运行的认领。" },
  "task-witness-rerun": { domain: "task", name: "重跑完成门", description: "保留前次结果并开启下一次完成门运行。" },
  "task-contract-migrate": { domain: "task", name: "迁移任务合同", description: "将任务合同迁移到新版本。" },
  "task-create": { domain: "task", name: "创建任务", description: "登记新的任务及其合同。" },
  "task-declare-executor": { domain: "task", name: "声明任务执行者", description: "登记任务执行者。" },
  "task-delete": { domain: "task", name: "删除任务", description: "删除指定任务。" },
  "task-dispatch-review": { domain: "task", name: "派发任务审查", description: "请求独立审查任务交付。" },
  "task-pin": { domain: "task", name: "固定任务引用", description: "固定任务引用的资料版本。" },
  "task-rematerialize": { domain: "task", name: "重新生成任务文档", description: "从中心已接受内容重新生成任务文档。" },
  "task-progress-append": { domain: "task", name: "记录任务进展", description: "为任务追加进展记录。" },
  "task-push": { domain: "task", name: "发布任务分支", description: "通过 daemon 发布当前任务分支。" },
  "task-release": { domain: "task", name: "释放任务领用", description: "释放当前任务的领用租约。" },
  "task-reopen": { domain: "task", name: "重新打开任务", description: "将已关闭任务重新打开。" },
  "task-review-consent": { domain: "task", name: "确认任务交付", description: "记录业主对交付的确认。" },
  "task-rework": { domain: "task", name: "退回任务返工", description: "在自动返工次数用完后由业主带理由退回任务。" },
  "task-review-execution": { domain: "task", name: "审查任务执行", description: "提交对任务执行的独立审查意见。" },
  "task-respond-review": { domain: "task", name: "回应任务审查", description: "逐条回应任务审查意见。" },
  "task-settle": { domain: "task", name: "结算任务执行", description: "记录执行的结算结果。" },
  "task-start": { domain: "task", name: "开始任务", description: "领取并开始执行任务。" },
  "task-submit": { domain: "task", name: "提交任务交付", description: "将任务交付提交供审查。" },
  "task-supersede": { domain: "task", name: "替代任务", description: "用新任务替代旧任务。" },
  "task-transition": { domain: "task", name: "推进任务状态", description: "执行任务生命周期的状态转换。" },
  "task-unpin": { domain: "task", name: "取消任务固定引用", description: "解除任务资料的版本固定。" },
  "terminal-input": { domain: "terminal", name: "输入终端", description: "向已打开的终端发送输入。" },
  "terminal-resize": { domain: "terminal", name: "调整终端大小", description: "调整终端行列尺寸。" },
  "terminal-spawn": { domain: "terminal", name: "打开终端", description: "创建新的终端会话。" },
  "terminal-terminate": { domain: "terminal", name: "关闭终端", description: "结束指定终端会话。" },
  "vertical-declaration-migrate": { domain: "vertical", name: "迁移领域声明", description: "迁移业务领域的声明版本。" },
  "vertical-kind-publish-schema": { domain: "vertical", name: "发布领域结构", description: "发布业务领域的数据结构。" },
  "vertical-kind-retire": { domain: "vertical", name: "退役领域类型", description: "结束业务领域类型的使用。" },
  "vertical-kind-upsert": { domain: "vertical", name: "维护领域类型", description: "创建或更新业务领域类型。" },
} as const;

export type ActionExecutionClass = "repo-read" | "repo-write" | "arbiter" | "admin";
export type ActionPolicyTier = "viewer" | "contributor" | "maintainer" | "admin";
export type ActionResidency =
  | { readonly scope: "canonical"; readonly writer: "center-repo-cell" }
  | { readonly scope: "runtime-local"; readonly writer: "runtime-host" }
  | { readonly scope: "host-local"; readonly writer: "daemon-host" };
export type ReceiptSettlementClass = "canonical-acceptance" | "none";

/** The authoritative facets shared by policy, protocol, receipt settlement, and entity catalogs. */
export interface ActionDeclaration {
  readonly kind: string;
  readonly catalogId: string | null;
  readonly executionClass: ActionExecutionClass;
  readonly policyAction: string;
  readonly policyTier: ActionPolicyTier;
  readonly residency: ActionResidency;
  readonly receiptSettlement: ReceiptSettlementClass;
  readonly writeRoad?: "lifecycle.event-publication" | "workspace.bootstrap" | "daemon.runtime-control";
  /** Host-local writers that still need the acting person's session; socket ownership alone is not authority. */
  readonly socketOwnerAuthority?: boolean;
}

const canonicalResidency = Object.freeze({ scope: "canonical" as const, writer: "center-repo-cell" as const }),
  runtimeResidency = Object.freeze({ scope: "runtime-local" as const, writer: "runtime-host" as const }),
  hostResidency = Object.freeze({ scope: "host-local" as const, writer: "daemon-host" as const });

const policyTierFor = (executionClass: ActionExecutionClass): ActionPolicyTier =>
  executionClass === "repo-read"
    ? "viewer"
    : executionClass === "repo-write"
      ? "contributor"
      : executionClass === "arbiter"
        ? "maintainer"
        : "admin";

const canonical = (
  kind: keyof typeof actionPresentation,
  catalogId: string | null,
  executionClass: ActionExecutionClass,
  receiptSettlement: ReceiptSettlementClass = "canonical-acceptance",
  policyTier: ActionPolicyTier = policyTierFor(executionClass),
  writeRoad?: ActionDeclaration["writeRoad"],
  policyAction: string = kind,
): ActionDeclaration =>
  Object.freeze({
    kind,
    catalogId,
    executionClass,
    policyAction,
    policyTier,
    residency: canonicalResidency,
    receiptSettlement,
    ...(writeRoad === undefined ? {} : { writeRoad }),
  });

const canonicalWithPolicyAction = (
  kind: keyof typeof actionPresentation,
  catalogId: string,
  executionClass: ActionExecutionClass,
  policyAction: string,
): ActionDeclaration => canonical(kind, catalogId, executionClass, undefined, undefined, undefined, policyAction);

/** Commanding a submitted cut and closing a task are lifecycle closure: the maintainer tier, never the creator. */
const closure = (
  kind: keyof typeof actionPresentation,
  catalogId: string,
  writeRoad?: ActionDeclaration["writeRoad"],
): ActionDeclaration => canonical(kind, catalogId, "repo-write", "canonical-acceptance", "maintainer", writeRoad);

const local = (
  kind: keyof typeof actionPresentation,
  executionClass: ActionExecutionClass,
  residency: Exclude<ActionResidency, { readonly scope: "canonical" }>,
  overrides: { readonly policyTier?: ActionPolicyTier; readonly receiptSettlement?: ReceiptSettlementClass } = {},
): ActionDeclaration =>
  Object.freeze({
    kind,
    catalogId: null,
    executionClass,
    policyAction: kind,
    policyTier: overrides.policyTier ?? policyTierFor(executionClass),
    residency,
    // A local writer has no canonical command outcome unless it says otherwise; the one caller that
    // settles a declared no-write keeps canonical-acceptance so the receipt reads settled_no_write.
    receiptSettlement: overrides.receiptSettlement ?? "none",
  });

const hostAdmin = (
  kind: keyof typeof actionPresentation,
  writeRoad?: ActionDeclaration["writeRoad"],
  socketOwnerAuthority = true,
): ActionDeclaration =>
  Object.freeze({
    kind,
    catalogId: null,
    executionClass: "admin",
    policyAction: kind,
    policyTier: "admin",
    residency: hostResidency,
    receiptSettlement: "none",
    ...(writeRoad === undefined ? {} : { writeRoad }),
    ...(socketOwnerAuthority ? {} : { socketOwnerAuthority: false }),
  });

const runtimeAdmin = (kind: keyof typeof actionPresentation): ActionDeclaration =>
  Object.freeze({
    kind,
    catalogId: null,
    executionClass: "admin",
    policyAction: kind,
    policyTier: "admin",
    residency: runtimeResidency,
    receiptSettlement: "none",
  });

/**
 * The built-in permission action inventory. Protocol descriptors are checked against these rows;
 * policy, entity-catalog bindings, and receipt settlement are projections of the declarations.
 */
export const actionDeclarations = Object.freeze([
  canonical("repository-read", null, "repo-read", "none"),
  canonical("agent-assign", "agent/assign", "repo-write"),
  canonical("agent-delete", "agent/delete", "repo-write"),
  canonical("agent-unassign", "agent/unassign", "repo-write"),
  canonical("assignment-migrate", "relation/migrate-assignment", "repo-write"),
  canonical("agent-retire", "agent/retire", "repo-write"),
  canonical("agent-install", "agent/install", "repo-write"),
  local("agent-run", "repo-write", runtimeResidency),
  hostAdmin("daemon-connection-add"),
  hostAdmin("daemon-connection-probe"),
  hostAdmin("daemon-connection-remove"),
  hostAdmin("daemon-connection-update"),
  hostAdmin("ledger-backup", "workspace.bootstrap"),
  hostAdmin("ledger-restore-drill", "workspace.bootstrap"),
  hostAdmin("daemon-control-request", undefined, false),
  hostAdmin("daemon-fleet-center-start", undefined, false),
  hostAdmin("daemon-fleet-edge-sync", undefined, false),
  hostAdmin("permission-request-create"),
  hostAdmin("permission-request-decide"),
  hostAdmin("permission-request-withdraw"),
  hostAdmin("daemon-repo-register", "workspace.bootstrap"),
  hostAdmin("repo-purge", "workspace.bootstrap"),
  hostAdmin("repo-unbind", "workspace.bootstrap"),
  hostAdmin("daemon-repo-update"),
  hostAdmin("daemon-service-install"),
  hostAdmin("daemon-service-uninstall"),
  hostAdmin("daemon-start", "daemon.runtime-control", false),
  hostAdmin("daemon-stop", "daemon.runtime-control", false),
  canonical("decision-accept", "decision/accept", "repo-write"),
  canonical("decision-amend", "decision/amend", "repo-write"),
  canonical("decision-assign", "decision/assign", "repo-write"),
  canonical("decision-unassign", "decision/unassign", "repo-write"),
  canonical("decision-claim-add", "decision/declare-claim", "repo-write"),
  canonical("decision-claim-fulfill", "decision/fulfill-claim", "repo-write"),
  canonical("decision-defer", "decision/defer", "repo-write"),
  canonical("decision-dispatch-review", "decision/dispatch-review", "repo-write"),
  canonical("decision-propose", "decision/propose", "repo-write"),
  canonical("decision-reckon", "decision/reckon", "repo-write"),
  canonical("decision-reject", "decision/reject", "arbiter"),
  canonical("decision-rematerialize", "decision/rematerialize", "repo-write"),
  canonical("decision-repin", "decision/repin", "repo-write"),
  canonical("decision-review", "decision/review", "arbiter"),
  canonical("decision-respond-review", "decision/respond-review", "repo-write"),
  canonical("decision-override-review", "decision/override-review", "arbiter"),
  canonical("decision-retire", "decision/retire", "repo-write"),
  canonical("decision-transition", "decision/transition", "repo-write"),
  local("distill-candidate", "repo-write", hostResidency),
  canonical("distill-promote", "fact/promote", "repo-write"),
  local("doc-conflict-discard-local", "repo-write", hostResidency),
  canonical("doc-conflict-overwrite-center", "document/conflict-overwrite-center", "repo-write"),
  canonical("doc-conflict-resolve", "document/conflict-resolve", "repo-write"),
  local("doc-materialize", "repo-write", hostResidency),
  canonical("doc-retire", "document/retire", "repo-write"),
  canonical("doc-submit", "document/submit", "repo-write"),
  canonical("entity-archive", null, "repo-write"),
  canonical("entity-delete", null, "repo-write"),
  canonical("entity-import", null, "repo-write"),
  canonicalWithPolicyAction("entity-pin", "task/pin", "repo-write", "task/pin"),
  canonicalWithPolicyAction("entity-unpin", "task/unpin", "repo-write", "task/unpin"),
  canonical("entity-update", null, "repo-write"),
  canonical("fact-archive", "fact/archive", "repo-write"),
  canonical("fact-assign", "fact/assign", "repo-write"),
  canonical("fact-unassign", "fact/unassign", "repo-write"),
  canonical("fact-unarchive", "fact/unarchive", "repo-write"),
  canonical("fact-reclassify", "fact/reclassify", "repo-write"),
  canonical("fact-record", "fact/record", "repo-write"),
  canonical("fact-rematerialize", "fact/rematerialize", "repo-write"),
  canonical("fact-type-register", "fact/type-register", "repo-write"),
  canonical("migrate-import", "migration/import", "repo-write"),
  canonical("people-delegate", "person/delegate", "admin"),
  canonical("people-revoke-delegation", "person/revoke-delegation", "admin"),
  local("preset-install", "repo-write", hostResidency),
  local("preset-run-start", "repo-write", runtimeResidency),
  local("preset-seed", "repo-write", hostResidency),
  local("preset-uninstall", "repo-write", hostResidency),
  canonical("preset-upgrade", "task/preset-upgrade", "repo-write"),
  local("projection-rebuild", "repo-write", hostResidency),
  hostAdmin("provider-create"),
  hostAdmin("provider-delete"),
  hostAdmin("provider-list"),
  hostAdmin("provider-probe"),
  hostAdmin("provider-show"),
  hostAdmin("provider-update"),
  hostAdmin("rbac-bootstrap", "workspace.bootstrap"),
  canonical("relation-reconfirm", "relation/reconfirm", "repo-write"),
  canonical("relation-relate", "relation/relate", "repo-write"),
  canonical("relation-unrelate", "relation/unrelate", "repo-write"),
  hostAdmin("repo-bootstrap", "workspace.bootstrap", false),
  // Runtime control is host ingress, not entity-catalog write actions: the canonical events these
  // commands cause are appended by the RuntimeSession event actions (runtime_session_*), by the
  // auxiliary runtime ingress, or by the dispatch writer, each under its own canonical action. The
  // command's own state is the process/checkpoint state on the host that owns the runtime, so it
  // stays local (dec_2446BC2F8C68630F71AE3E3BD7/CH4 "no write path of its own"). Receipt settlement
  // is unchanged: these receipts still accept the canonical outcome produced by that writer.
  local("runtime-batch", "repo-write", hostResidency, { receiptSettlement: "canonical-acceptance" }),
  local("runtime-cancel", "repo-write", runtimeResidency, { receiptSettlement: "canonical-acceptance" }),
  // The steer's only durable effect is a dispatch-stream record; it appends no ledger event
  // (runtime-spawn-control.ts, settled_no_write receipt). Its receipt still settles through the
  // declared no-write path, so the GUI command keeps canonical-acceptance.
  local("runtime-steer", "repo-write", runtimeResidency, { receiptSettlement: "canonical-acceptance" }),
  local("runtime-handoff-export", "repo-write", hostResidency, {
    receiptSettlement: "canonical-acceptance",
  }),
  local("runtime-handoff-claim", "repo-write", hostResidency, { receiptSettlement: "canonical-acceptance" }),
  local("runtime-handoff-revoke", "repo-write", hostResidency, { receiptSettlement: "canonical-acceptance" }),
  // Owner adjudication of an escalated incident receipt: the dismiss appends one decision_action
  // record to the dispatch's own stream and settles no canonical event, so its state stays on the
  // daemon host. The maintainer tier is preserved: reclassification must not widen who may dismiss.
  local("runtime-incident-dismiss", "repo-write", hostResidency, { policyTier: "maintainer" }),
  runtimeAdmin("runtime-instance-create"),
  runtimeAdmin("runtime-instance-delete"),
  runtimeAdmin("runtime-instance-hosting-credential-set"),
  runtimeAdmin("runtime-instance-hosting-credential-unset"),
  runtimeAdmin("runtime-instance-list"),
  local("runtime-instance-login", "repo-write", runtimeResidency),
  local("runtime-instance-logout", "repo-write", runtimeResidency),
  runtimeAdmin("runtime-instance-show"),
  runtimeAdmin("runtime-instance-update"),
  // dec_6C9E3399972A2F06C046BA89DC/CH3: ha runtime run and ha agent run share the canonical
  // runtime-session/run target; Policy action stays runtime-run and the command behavior is unchanged.
  canonicalWithPolicyAction("runtime-run", "runtime-session/run", "repo-write", "runtime-run"),
  local("runtime-spawn", "repo-write", runtimeResidency, { receiptSettlement: "canonical-acceptance" }),
  canonical("todo-add", "todo/add", "repo-write"),
  canonical("todo-done", "todo/done", "repo-write"),
  canonical("todo-archive", "todo/archive", "repo-write"),
  canonical("todo-reopen", "todo/reopen", "repo-write"),
  canonical("todo-relate", "todo/relate", "repo-write"),
  canonical("todo-promote", "todo/promote", "repo-write"),
  canonical("schedule-claim", "schedule/claim", "repo-write"),
  canonical("schedule-assign", "schedule/assign", "repo-write"),
  canonical("schedule-create", "schedule/create", "repo-write"),
  canonical("schedule-delete", "schedule/delete", "repo-write"),
  canonical("schedule-disable", "schedule/disable", "repo-write"),
  canonical("schedule-dispatch-link", "schedule/link", "repo-write"),
  canonical("schedule-enable", "schedule/enable", "repo-write"),
  canonical("schedule-missed", "schedule/record-missed", "repo-write"),
  canonical("schedule-run-now", "schedule/run-now", "repo-write"),
  canonical("schedule-settle", "schedule/settle", "repo-write"),
  canonical("schedule-unassign", "schedule/unassign", "repo-write"),
  canonical("schedule-update", "schedule/update", "repo-write"),
  canonical("script-run", "script-execution/run", "repo-write"),
  canonical("settings-update", "settings/update", "repo-write"),
  canonical("squad-cancel", "squad/cancel", "repo-write"),
  canonical("squad-assign", "squad/assign", "repo-write"),
  canonical("squad-delete", "squad/delete", "repo-write"),
  canonical("squad-install", "squad/install", "repo-write"),
  canonical("squad-run", "squad/run", "repo-write"),
  canonical("squad-unassign", "squad/unassign", "repo-write"),
  closure("task-assign", "task/assign"),
  closure("task-unassign", "task/unassign"),
  canonical("task-amend", "task/amend", "repo-write"),
  canonical("task-annotate", "task/annotate", "repo-write"),
  canonical("task-archive", "task/archive", "repo-write"),
  canonical("task-artifact-add", "task/artifact-add", "repo-write"),
  canonical("task-attest", "task/attest", "repo-write"),
  closure("task-witness-claim", "task/witness-claim"),
  closure("task-witness-settle", "task/witness-settle"),
  closure("task-witness-revoke", "task/witness-revoke"),
  closure("task-witness-rerun", "task/witness-rerun"),
  closure("task-complete", "task/complete", "lifecycle.event-publication"),
  canonical("task-contract-migrate", "task/contract-migrate", "repo-write"),
  canonical("task-create", "task/create", "repo-write", undefined, undefined, "lifecycle.event-publication"),
  canonical("task-declare-executor", "task/declare-executor", "repo-write"),
  canonical("task-delete", "task/delete", "repo-write"),
  canonical("task-dispatch-review", "task/dispatch-review", "repo-write", "none"),
  canonical("task-rematerialize", "task/rematerialize", "repo-write"),
  canonical("task-progress-append", "task/progress-append", "repo-write"),
  canonical("task-push", "task/push", "repo-write", "none"),
  canonical("task-release", "task/release", "repo-write"),
  canonical("task-reopen", "task/reopen", "repo-write"),
  closure("task-review-consent", "task/consent"),
  closure("task-rework", "task/rework", "lifecycle.event-publication"),
  canonical("task-review-execution", "task/review", "arbiter", undefined, undefined, "lifecycle.event-publication"),
  canonical(
    "task-respond-review",
    "task/respondReview",
    "repo-write",
    undefined,
    undefined,
    "lifecycle.event-publication",
  ),
  canonical("task-settle", "task/settle", "repo-write"),
  canonical("task-start", "task/start", "repo-write"),
  canonical("task-submit", "task/submit", "repo-write", undefined, undefined, "lifecycle.event-publication"),
  canonical("task-supersede", "task/supersede", "repo-write"),
  canonical("task-transition", "task/transition", "repo-write"),
  local("terminal-input", "repo-write", runtimeResidency),
  local("terminal-resize", "repo-write", runtimeResidency),
  local("terminal-spawn", "repo-write", runtimeResidency),
  local("terminal-terminate", "repo-write", runtimeResidency),
  canonical("vertical-declaration-migrate", "vertical-declaration/migrate", "repo-write"),
  canonical("vertical-kind-publish-schema", "vertical-declaration/publish-kind-schema", "repo-write"),
  canonical("vertical-kind-retire", "vertical-declaration/retire-kind", "repo-write"),
  canonical("vertical-kind-upsert", "vertical-declaration/upsert-kind", "repo-write"),
] as const satisfies readonly ActionDeclaration[]);

const actionKinds = new Set(actionDeclarations.map(({ kind }) => kind)),
  actionDeclarationByCatalogId = new Map(
    actionDeclarations.flatMap((declaration) =>
      declaration.catalogId === null ? [] : ([[declaration.catalogId, declaration]] as const),
    ),
  );

if (actionKinds.size !== actionDeclarations.length) throw new Error("Action declaration kinds must be unique.");
if (actionDeclarationByCatalogId.size !== actionDeclarations.filter(({ catalogId }) => catalogId !== null).length)
  throw new Error("Action declaration catalog ids must be unique.");

export function getActionDeclarationByCatalogId(catalogId: string): ActionDeclaration | undefined {
  return actionDeclarationByCatalogId.get(catalogId);
}

/** Non-read policy scopes derive solely from ActionDeclaration. */
export const durablePolicyActions = Object.freeze(
  actionDeclarations.flatMap(({ policyAction, executionClass }) =>
    executionClass === "repo-read" ? [] : [policyAction],
  ),
);
