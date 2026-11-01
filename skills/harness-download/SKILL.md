---
name: harness-download
description: 引导用户从首次下载到开始使用 Harness Anything：检查环境、获取持久源码、安装依赖、把整套技能链接到所选 Agent 的用户目录，随后继续目标仓库初始化和主控技能首次使用。用于用户要求下载、安装全套、首次接入或一段话带完 Harness；当前使用源码分发，不假定已有 npm 发布包。
---

# Harness 下载与首次引导

这是首次使用的总入口。完成顺序是：环境与持久源码 → 用户级技能链接 → 目标仓库的 `harness-install` → `harness-ceo` 知识初始化与首个真实任务。阶段之间由当前 Agent 继续执行，不要求用户重新发一遍提示词。

只安装本机工具、不初始化项目，也是合法的用户范围；此时在工具与技能可用后交付，不擅自挑一个仓库写入。用户指定完整引导时，不能只下载完就宣布完成。

## 0. 先读取，再补充必要信息

查当前目录、用户指定项目、已有 Harness 源码与 CLI、系统类型、Git、Node、npm、已安装 Agent 及其技能目录。Bun 只用于运行 Skills CLI，不代替 Harness 要求的 Node。首次安装技能本身不等于已安装 Harness 运行时。

用户给过的信息直接复用。只合并询问仍缺少且影响执行的信息：目标仓库、源码放置位置（没有偏好可建议 `~/.harness-anything-src`）、要接入哪些已安装 Agent、首次任务。仓库身份、owner 和既有指令修改的审批留到 `harness-install` 的具体可审阅步骤。

把本次实际源码、Node 路径、CLI 入口、选定技能目录记在安装交接中，跨工具调用传递明确路径，不依赖临时 shell 变量一直存在。

## 1. 获取持久源码与运行环境

当前发布方式是从 `https://github.com/FairladyZ625/harness-anything.git` 的 `main` 获取源码。本技能可能先由 `bunx skills add` 安装到工具管理的副本；该副本只有技能，不是可运行的完整仓库。

```bash
node --version
npm --version
git --version
```

要求以源码 `package.json` 的 `engines` 为准，当前为 Node 24+。缺少依赖时给出适合系统的安装方式并在已有授权内完成；需管理员操作或交互安装时等待对应步骤，继续其他独立准备。不要修改全局环境来绕过明确审批。

原生依赖可能需要构建工具：macOS 检查命令行开发工具，Linux 检查 C/C++ 工具链和 Python，Windows 检查受依赖支持的构建环境。依赖安装失败时读真实构建错误；不要用 `--ignore-scripts` 把失败掩盖到守护进程启动阶段。

没有现成源码时，把 `<源码目录>` 替换为已选的持久目录：

```bash
git clone --depth 1 --branch main https://github.com/FairladyZ625/harness-anything.git "<源码目录>"
```

已有目录时先检查 remote、分支和改动；不覆盖非本项目目录，不重置用户改动，不在开发工作树里直接拉主干。只有归属明确、干净且适合更新的源码安装才走正常快进更新。测试本技能的候选分支时明确记录该分支，后续步骤使用同一份候选包，不偷偷切回主干。

源码不能放临时目录：技能链接和守护进程随后都依赖这个持久位置。

开始装依赖前先把等待成本告诉用户，不要等命令跑起来才说。`npm ci` 只负责 JS 依赖；Electron 二进制由它自带的安装器单独下载。当前锁文件里的 `electron@42.11.16` 已经没有 `postinstall`，npm 的 install-scripts 列表里也没有它，所以 `allowScripts` 放行不了不存在的脚本，必须显式跑 `node node_modules/electron/install.js`。本机 macOS arm64 两次干净 clone 实测（2026-11-01，Node 26.8.2 / npm 11.19.1，干净 npm 与 Electron 缓存）：`npm ci` 45–53 秒，Electron 下载 98–149 秒，三包构建 53–57 秒（daemon 23–26 秒、CLI 27–28 秒、GUI 3 秒），从 `npm ci` 到构建完成 3 分 24 秒–4 分 11 秒；npm 缓存约 149 MiB，Electron 下载缓存约 128 MiB（合计约 277 MiB），装完 `node_modules` 约 993 MiB，其中 Electron 约 295 MiB。用户机器和网络会不同，按同一数量级预告即可。等待期间可以继续读第 2 节的技能目标目录、确认要接入的 Agent，但不要重复开第二个安装、不要删除 `node_modules`。进度直接看命令输出；Electron 下载阶段可以另开终端跑 `du -sh node_modules/electron/dist` 看增长。安装失败时读真实构建错误，不用 `--ignore-scripts` 把失败掩盖到守护进程启动阶段。

在源码目录执行（一次装齐 CLI、daemon、GUI）：

```bash
npm ci --no-audit --no-fund
node node_modules/electron/install.js
npm run build -w @harness-anything/daemon
npm run build -w @harness-anything/cli
npm run build -w @harness-anything/gui
```

`node node_modules/electron/install.js` 是幂等的：已装好会直接退出，缺二进制才会下载。构建顺序有依赖：daemon 的 bin 是 CLI daemon autostart 的入口，CLI 的 bin 是 `ha`，GUI 的产物是 `ha gui` 加载的窗口。三步都必须成功；缺一步只会在后面启动时才报错。源码 CLI 的 daemon 自动启动入口来自 daemon 包的 bin（`dist/index.js`），所以 `--version` / `--help` 成功不能证明该入口存在。当前 Git 钩子不会替你构建。

先验证 Electron 运行时真的落地。不要用 `require('electron')` 做这一步：它在 `path.txt` 缺失时会自己触发下载，把“安装脚本没跑”伪装成成功。直接读 `path.txt` 并检查二进制：

```bash
node -e "const fs=require('fs'),path=require('path');const root=path.dirname(require.resolve('electron/package.json'));const rel=fs.readFileSync(path.join(root,'path.txt'),'utf8').trim();const bin=path.join(root,'dist',rel);fs.accessSync(bin,fs.constants.X_OK);console.log(bin)"
```

macOS 也可以直接看 `node_modules/electron/dist/Electron.app`；Linux/Windows 以该命令输出的实际二进制路径为准。

让 `ha` 指向本次源码。干净源码安装不会自动生成根 `node_modules/.bin/ha`（CLI 不是任何 workspace 的依赖），所以不能靠它。二选一：

不碰宿主 npm 全局前缀、先让当前会话可用：

```bash
npm_config_prefix="$HOME/.harness-anything/npm-global" npm link -w @harness-anything/cli
export PATH="$HOME/.harness-anything/npm-global/bin:$PATH"
command -v ha
ha --version
```

这会把链接放进 `$HOME/.harness-anything/npm-global`，不写宿主 npm 全局前缀；删除该目录即可撤销。Windows PowerShell 用 `$env:npm_config_prefix` 和 `$env:PATH` 的等价写法。

如果用户要的是“以后每个 shell 都有 `ha`”，再展示修改宿主 npm 全局前缀的提案，取得同意后执行：

```bash
npm link -w @harness-anything/cli
```

先给出会写入的 `npm prefix -g` 路径和可逆命令 `npm unlink -g @harness-anything/cli`，不要静默执行。

`command -v ha` 必须是本次 link 出来的路径；`ha --version` 必须等于 `packages/cli/package.json` 的 `version`。

GUI 的生产启动入口是 `ha gui`，不是 `npm run dev:electron`（后者只用于贡献者 hot reload）：

```bash
ha gui                 # 打开当前仓库
ha gui --root <仓库>   # 打开指定仓库
```

`ha gui` 会构建缺失或过期的 renderer/preload，经 CLI 的 daemon autostart 取得 default daemon，再 detached 启动 Electron；关闭窗口不会停 daemon。首次启动 daemon 可能要几秒，回执里会给日志路径。

验收时不要弹可见窗口：

```bash
npm run smoke:gui:headless
```

它用构建后的 `dist-electron/electron-main.js` 启动 Electron，断言 renderer 已加载且窗口不可见、未聚焦，输出 `gui headless smoke: ok`。只验证 daemon 自启、不开窗口时运行：

```bash
ha gui --browser
```

看到 `Harness Anything GUI available at http://127.0.0.1:...` 就说明 daemon 已由 CLI autostart 拉起；按 Ctrl-C 结束 broker（它不会停 daemon）。

第 1 节完成前逐项核对：

- `command -v ha` 指向本次源码 link 出来的 `ha`；
- `ha --version` 等于 `packages/cli/package.json` 的 `version`；
- 上面那条读 `path.txt` 的命令输出一个可执行文件路径；
- `npm run smoke:gui:headless` 输出 `gui headless smoke: ok`；
- `ha gui --browser` 输出 GUI URL（证明 daemon 自启）。

本节是源码安装的唯一配方。npm 正式发布后替换本节，不要在 README 或 start 文档里再维护第二套源码安装命令。

## 2. 将整套技能链接到选定 Agent

使用源码内唯一的技能同步工具。无参数只处理源码仓库自身的项目目录；用户级安装必须显式给出用户选择的目标目录。

例如用户选择 Codex 和 Claude Code，且未配置自定义目录时：

```bash
node "<源码目录>/tools/sync-runtime-skills.mjs" \
  --target-dir "$HOME/.codex/skills" \
  --target-dir "$HOME/.claude/skills"
```

Codex 配置了自定义 `CODEX_HOME` 时使用其 `skills` 子目录；Claude Code 配置了 `CLAUDE_CONFIG_DIR` 时同样尊重其目录。其他 Agent 按其真实配置或当前 Skills CLI 的 Agent 目录表选择；不要猜目录，也不要因为目录列表存在就给全部产品安装。

工具扫描源码的 `skills/`，链接整套技能和它们的参考资料，不另外维护技能名单。相同来源链接可重复运行；现有目录、其他来源链接和失效的其他来源链接都先报冲突，不自动覆盖。各用户目录与源码目录是本机安装面，不写项目台账。

Skills CLI 安装的引导副本可能与源码链接目标同名。先核实其来源、内容和用户定制：本次刚安装且未定制的副本可在本次安装范围内保留到技能发现目录之外，再用源码链接替代；不是本次创建、包含定制或归属不明的内容，展示冲突和具体处置后取得确认。不要删除 Skills CLI 的共享存储，因为其他 Agent 可能还引用它。

Windows 若无法创建目录符号链接，报告具体权限条件，引导用户按宿主支持方式启用；不静默改成复制后宣称已建立源码链接。

回读各目标中 `harness-download`、`harness-install`、`harness-ceo` 的真实解析路径和参考文件，确认都指向选定持久源码。需要宿主刷新才能出现在技能列表时说明，但当前 Agent 仍可以直接读取文件继续后续阶段。

## 3. 继续初始化目标仓库

从同一源码安装读取 `skills/harness-install/SKILL.md`，向它传递目标仓库、`ha` 入口（`<源码目录>/packages/cli/dist/cli/src/index.js`，或上面 link 出来的 `ha`）、已发现环境和用户已给的信息。不要再下载一份源码，不要求用户另开任务。

接入已有 Fleet 中心时，直接走 [harness-install 的边缘节点路线](../harness-install/SKILL.md#接入已有-fleet-中心的边缘节点)，不因 clone 中没有台账而重新 init。全新本地中心先满足该技能写明的身份前提；下载成功不代表初始化已经可用。

没有台账且确实是新中心时执行仓库初始化。已有台账时先辨别是当前可用工作区还是明确需要迁移的旧代；不能见到 `harness/` 就重新初始化或迁移。旧代迁移会改变已有数据，沿迁移技能的明确范围与审批办理，不把下载授权当成迁移授权。

下载、链接是节点本地动作；项目初始化属于中心权威写入。同一目标仓库多个节点同时引导时，先核实中心注册与 owner，只有已授权协调者初始化；其他节点连接已有工作区，不各自产生一份“权威”台账。

## 4. 接上主控使用与知识初始化

仓库可读写后，读取同一安装中的 `harness-ceo/SKILL.md` 和 `references/initialization.md`，映射用户约定、模型矩阵、问题记录与执行证据位置。复用已有内容，不要求填满空表或先测完所有模型。

以用户指定的首个真实任务启动主控流程，和 `harness-install` 的首任务验收共用一个任务，不跑两个演示。身份确认、既有指令合并、独立复核等确实需要用户或其他角色的步骤，交付具体材料后等待，不伪造批准或完成。

## 5. 交付与以后继续使用

交付源码位置与版本、可重复执行的 CLI 命令、技能链接及所选 Agent、目标工作区与知识入口、首任务真实状态和未完成原因。下一次可直接调用 `harness-ceo`；另一个仓库调用 `harness-install`，不用再下载一次工具。

本技能第 1 节已经把构建后的 `ha` 放在 `<源码目录>/node_modules/.bin`。交付时给出当前 shell 的 `ha ...` 命令和长期 PATH 方案；需要改 shell 启动文件或执行 `npm link` 时先展示提案取得同意。不要静默全局 npm 安装，也不要再让用户回到 `node packages/cli/src/index.ts`——那是故障排查入口，不是交付命令。普通安装不改测试专用环境，不在临时 daemon 根里创建一个离开本会话就失联的正式工作区。

源码升级前检查在飞执行与共享服务归属，使用支持的更新路径；更新后同步相同技能链接。用户知识矩阵和问题记录在项目工作区，源码更新不得覆盖。

安装目录与参数参考 [Skills CLI](https://github.com/vercel-labs/skills)；`bunx` 行为参考 [Bun 官方说明](https://bun.sh/docs/pm/bunx)。首次安装按当前工具实际回执确认落点，不混淆项目级与用户级目录。
