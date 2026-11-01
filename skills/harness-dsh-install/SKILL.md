---
name: harness-dsh-install
description: 在 macOS 的 DeepSeek Harness 桌面端安装 Harness Anything、全部使用技能与 DSH 插件，并验证 ha、预设和教程入口。用于用户要求同时安装 Harness 与 DeepSeek Harness 插件；已有 Harness 时复用，不重新安装。
---

# Harness + DeepSeek Harness 安装

## 边界与来源

本技能从「已安装 DSH、尚未安装 Harness」带到工具、技能和插件可用；已有 Harness 时只补缺项。仅支持 macOS 桌面端。只装 Harness 使用 [harness-download](../harness-download/SKILL.md)；项目接入由 [harness-install](../harness-install/SKILL.md) 负责。下载、依赖与 CLI/daemon/GUI 构建配方只在 harness-download 维护，不在这里复制。

安装对象以同一持久源码中的 `packages/dsh-plugin/package.json`、`cordis.patch.yml` 和本机 `dsh --help` 为准。插件为 private 时不得假定 npm 可安装；使用构建后的本地目录 `link:`。源码目录不能移动或删除。若所选正式源码中还没有该包，停止插件阶段，报告缺失路径与版本；不要自动切到其他人的开发分支。

## 1. 环境、版本和 profile（先只读）

1. 检查 `uname -s`、`node --version`、`npm --version`、`git --version`、`command -v ha`，并核对已有 Harness 来源与版本。Node 要求取 Harness 根 `package.json` 的 `engines`，不能只满足插件较低的 Node 下限。
2. DSH CLI 通常不在 PATH。先查用户已给的 App 位置，否则检查 `/Applications/DeepSeek Harness.app` 和 `~/Applications/DeepSeek Harness.app`。实际入口是 `<DSH App>/Contents/Resources/runtime/cli/bin/dsh`。使用完整引号路径运行 `--version` 和 `plugin --help`，不要依赖 shell alias。App 或 CLI 不存在时请用户先安装 macOS 桌面 DSH；本技能不代装或降级为 web profile。
3. 获取同一版本技能包对应的持久源码（复用 harness-download 的源码发现/获取步骤）。读取插件的 `engines.dsh`，用 SemVer CLI 对比上一步实测版本，包含 prerelease，与 DSH 自己的兼容规则相同。将占位值替换为该字段的实际范围和实测版本；`npm exec` 可临时取得工具，不要求先安装 Harness 依赖：

   ```bash
   npm exec --yes --package=semver@7 -- semver --include-prerelease --range '<实际 engines.dsh 范围>' '<实测 DSH 版本>'
   ```

   匹配时输出该版本并成功退出；不匹配时停止安装，列出实际版本与所需范围，请用户升级。若 npm 未能取得工具，保留原始错误并停在环境检查，不把获取失败说成版本过旧；不改 engines、不添加版本豁免。

4. 列出实际 DSH home 下的 profile **名称**，不打印配置正文或凭据。默认 home 是 `~/.dsh`，设置了 `DSH_HOME` 时尊重它：

   ```bash
   node --input-type=module -e 'import {readdirSync,existsSync} from "node:fs";import {join} from "node:path";import {homedir} from "node:os";const root=process.env.DSH_HOME||join(homedir(),".dsh");const p=join(root,"profiles");console.log(JSON.stringify({home:root,profiles:existsSync(p)?readdirSync(p,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name):[]},null,2))'
   ```

   没有 `dsh profile list` 命令，不编造它。展示名称及本次拟安装目标，请用户确认一个**桌面** profile；用户已经选过就沿用。不能因名称叫 desktop 就默选，不能改其他 profile。web profile 没有此插件所需的右侧 browser tab。若 profile 没有初始化，先让用户在桌面 App 完成首次启动，再列出并确认；不以 `--from-default-profile` 重建已有 profile。

无人应答时仍可完成只读检查与准备，profile 写入前保持待确认；测试仅用临时 `DSH_HOME` 与测试 profile，不碰用户 desktop。

## 2. 复用或准备 Harness，再补齐技能

有可用 Harness 时回读 `ha --version`、`ha gui --help`、`ha daemon status`，保留其 CLI 路径、源码和服务，不重装、不强制升级或重启。插件需要 `ha gui --browser --parent-origin`；`ha gui --help` 里没有 `--parent-origin` 说明 CLI 太旧，按版本不兼容处理。失败要区分「没有工具」和「已有服务暂不可用」；后者报告实际错误，不用重新安装解决。

没有 Harness 时，连续执行同一包内 harness-download 的工具准备阶段；暂不替用户选择项目或初始化台账。复用它的持久源码、构建后 CLI、daemon 与 GUI 验证。若已有 CLI 来自其他安装，仍需获取插件的持久源码，但只准备插件所需依赖与构建，不重新 link、覆盖已有 CLI 或重建全部 Harness。版本不兼容时报告冲突，先给出具体升级方案。

技能清单唯一来源是 `tools/sync-runtime-skills.mjs` 扫描的源码 `skills/`；**整套安装，不维护 DSH 专属名单**，插件本身不携带技能。DSH 按「项目 `.dsh/skills` → 项目 `.agents/skills` → 插件 `customSkillDirs` → `<DSH home>/skills` → `<agents home>/skills`」的顺序读取，前者优先（`@deepseek-ai/dsh-skill-filesystem` README「Roots and priority」）。因此只补到优先级最低的 `<agents home>/skills`：用户在任何一层改过的同名技能都继续生效，不会被补装的版本遮住。agents home 取 `DSH_AGENTS_HOME`，未设置时为 `~/.agents`：

```bash
node "<持久源码>/tools/sync-runtime-skills.mjs" --missing-only \
  --target-dir "<实际 agents home>/skills"
```

只补缺失目录：已有定制目录、其他来源链接和失效链接都保留，结果中的 `preserved` 要逐项回读，失效链接或缺 `SKILL.md` 必须列为未就绪，不能因“保留”就宣称安装成功。同源链接指向持久源码；源码更新会影响它们，更新前另行审阅。不得删除用户版本或 Skills CLI 共享存储来消除冲突。同名技能若在更高优先级目录已有用户版本，以用户版本为准并在交付记录列出；最终用 DSH 技能列表及实际加载内容核对，不只检查磁盘。

其他 Agent 只在用户也选用了它们时添加对应 `--target-dir`；目录解析沿用 harness-download，不给所有产品写配置。回读链接目标及技能参考资料，并请 DSH 刷新技能列表/新开会话确认发现。已有自定义技能如不满足所需能力，展示差异，由用户决定如何保留和合并。

## 3. 构建和安装插件

只在所选、归属明确的持久源码中操作。依赖缺失时按 harness-download 的依赖步骤准备；然后运行：

```bash
npm run build -w @harness-anything/dsh-plugin
```

检查包的 main、client 产物及 `cordis.patch.yml` 都存在，client 是 tsdown 的 `window.__ModuleLoader__` 形态，`dsh.client.external` 不含本包。不要复制别人的 node_modules 或把源码目录当作已构建产物。

**普通用户首选：** DSH 桌面「插件 → 添加插件」，填入 `link:<持久源码绝对路径>/packages/dsh-plugin`，查看安装预览后确认。该入口识别本机绝对路径并走与 CLI 相同的 profile 包安装；不填写未发布的 npm 包名。安装作用于当前 App profile，先确认它正是用户选定的那个。提示重载/重启时先保存会话，按 UI 回执办理；不要自动终止 App 或宿主服务。

**Agent 自动安装或 UI 不可用时的备选：** 用户确认 profile 后，以本机 CLI 的真实路径执行：

```bash
"<DSH App>/Contents/Resources/runtime/cli/bin/dsh" plugin --profile "<已确认的桌面 profile>" add "link:<持久源码绝对路径>/packages/dsh-plugin"
"<DSH App>/Contents/Resources/runtime/cli/bin/dsh" plugin --profile "<已确认的桌面 profile>" list --depth 0
```

若插件已安装且来源、构建与版本均正确，只做回读验证，不重复 add。来源不同时先展示具体替换结果，不直接改用户版本。只通过插件管理入口修改选定 profile；不手改整个配置、不清空 overrides、不读取或打印 provider token。安装失败保留原始错误与现场，不静默换源、降级或修改 DSH。

## 4. 验证，再交接

按真实完成程度报告，命令返回成功不代表桌面已验收：

- 在 DSH 的 bash 工具中执行 `ha --version` 与 `ha --root "<目标仓库>" --json daemon status`，确认它调用的是已核实的 CLI。若 GUI 启动的 App 没继承终端 PATH，先用绝对 CLI 路径验证，再给出持久 PATH 配置方案；不要仅在安装 shell `export PATH` 后宣称 DSH 也可调用。
- 在会话权限中开启完全权限，选择 `ha-ceo`，让 Agent 加载 `harness-ceo`；确认技能可发现且内容来自本次所选来源。`ha-worker` 用于已分配任务中的实现与验证。缺少技能时回到第 2 节；无权执行 ha 时先检查权限与 PATH。
- 侧栏出现 Harness Anything 入口，点开是教程。右上角「在这里打开」在插件页内嵌看板，首次会询问以后是否默认显示看板；「在会话旁打开」回到会话并在右侧 browser tab 打开看板。看板跟随当前选中会话所在的工作区；该工作区不是已登记的 Harness 仓库时，依次改用 DSH 中其他已登记的工作区、daemon 最近活跃的仓库，都没有才显示 `ha gui` 的引导页。两处看到的都应是真实台账数据，不是「Daemon 尚未就绪」。实时流、终端和原生文件需要原生 `ha gui`。
- 用户给了目标仓库且尚未接入时，继续同一包的 harness-install，再进入 harness-ceo 做首个真实任务；已有当前台账复用。旧代迁移走 harness-migration，保持其中数据与身份审批。没有身份服务/登录时如实报告 `configure_verify_failed`，不承诺能从空身份状态初始化。

自动化验收使用空 HOME、独立 `DSH_HOME`、`--no-open` 和 headless 浏览器。不要为验证弹窗、获取焦点、操作系统输入或更改用户剪贴板。桌面侧栏、真实模型执行和重启后发现若无法实测，标为 unverified 并给出上述具体检查步骤。

## 交付记录

给出 macOS/Node/DSH 版本、插件 engines 范围、CLI 与持久源码位置和版本、确认的 profile、安装方式及回读结果、技能新增/保留/冲突、重启或刷新提示、实际验证命令与输出、教程/看板验收及未完成阶段。不记录凭据、浏览器存储或个人配置正文。下载成功、技能文件存在和插件安装回执是三个不同结果，分别报告。
