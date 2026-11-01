/**
 * In-app tutorial copy. Every skill name, preset, command, and error code here
 * must exist in this repository or in the DSH build the plugin targets;
 * test/tutorial-content.test.ts checks the ones that can be checked mechanically.
 */

/** Public source repository; every Agent phrase names the skill file it relies on. */
export const REPOSITORY_URL = "https://github.com/FairladyZ625/harness-anything";
const skillUrl = (skill: string): string => `${REPOSITORY_URL}/blob/main/skills/${skill}/SKILL.md`;

export interface TutorialItem {
  readonly title?: string;
  readonly body?: string;
  /** A shell command, shown in monospace with a copy button. */
  readonly command?: string;
  /** A sentence to paste into the DSH chat, shown with a copy button. */
  readonly say?: string;
  /** Skill or preset name shown as a tag next to the title. */
  readonly tag?: string;
}

export interface TutorialSection {
  readonly id: string;
  readonly title: string;
  readonly intro?: string;
  readonly numbered?: boolean;
  readonly items: readonly TutorialItem[];
}

export interface TutorialCopy {
  readonly title: string;
  readonly lead: string;
  /** Show the board inside this plugin page. */
  readonly openHere: string;
  /** Show the board in DSH's built-in browser beside the session. */
  readonly openBeside: string;
  readonly openHint: string;
  readonly backToTutorial: string;
  readonly opening: string;
  readonly retry: string;
  readonly askDefault: string;
  readonly askYes: string;
  readonly askNo: string;
  readonly copy: string;
  readonly copied: string;
  readonly sayLabel: string;
  readonly commandLabel: string;
  readonly contents: string;
  readonly next: string;
  /** Tab labels, in the order of TUTORIAL_LAYOUT. */
  readonly tabs: readonly string[];
  readonly sections: readonly TutorialSection[];
}

const zh: TutorialCopy = {
  title: "Harness Anything",
  lead: "让 Agent 把需求拆成任务、派人去做、交付后验收，每一步都记在仓库的台账里。这一页从零教你用起来，照着做就行。",
  openHere: "在这里打开",
  openBeside: "在会话旁打开",
  openHint: "看板显示当前会话文件夹里的台账。想一边对话一边看，选「在会话旁打开」。",
  backToTutorial: "← 教程",
  opening: "正在打开 Harness…",
  retry: "重试",
  askDefault: "以后点开插件，直接显示看板？",
  askYes: "是，默认看板",
  askNo: "不，先看教程",
  copy: "复制",
  copied: "已复制",
  sayLabel: "发给 Agent",
  commandLabel: "命令",
  contents: "目录",
  next: "下一页：",
  tabs: ["开始使用", "第一次走一遍", "用哪个 skill", "出问题怎么办", "按仓库定制"],
  sections: [
    {
      id: "what",
      title: "这是什么",
      items: [
        {
          body: "Harness Anything 是给 Agent 用的项目台账。任务、决定、评审结论都存在仓库的 `harness/` 目录里，Agent 用 `ha` 命令读写它。",
        },
        {
          title: "源码仓库",
          body: "Harness 的源码、全部 skill 和安装说明都在这里。下面每句发给 Agent 的话都带了对应 skill 的地址，Agent 本地找不到也能照着装。",
          command: REPOSITORY_URL,
        },
        {
          body: "这个插件做三件事：加上 `ha-ceo` 和 `ha-worker` 两个预设；自带 Harness 的全部 skill；在右侧打开 Harness 看板。看板上显示的，就是 Agent 写进台账的内容。",
        },
      ],
    },
    {
      id: "check",
      title: "开始之前：检查三样东西",
      numbered: true,
      items: [
        {
          title: "插件已装好",
          body: "你能看到这一页，说明插件已经装进当前 DSH。会话的预设列表里应该有 `ha-ceo` 和 `ha-worker`。",
        },
        {
          title: "`ha` 命令可用",
          body: "新建会话，把权限切到「完全权限」，发下面这句话。能看到版本号就没问题；提示找不到命令，去「一键安装」那一栏。",
          say: "运行 ha --version 和 ha daemon status，把结果原样告诉我。",
        },
        {
          title: "仓库已接入 Harness",
          body: "仓库根目录有 `harness/harness.yaml` 就是已接入。没有的话，去「第一次完整走一遍」的第 3 步。",
        },
      ],
    },
    {
      id: "install",
      title: "一键安装 Harness 和全部 skill",
      intro: "还没装 `ha`，或换了一台 Mac，把这句话发给 Agent。已经装好的部分会直接复用，不会重装。",
      items: [
        {
          tag: "harness-dsh-install",
          say: `用 harness-dsh-install skill（${skillUrl("harness-dsh-install")}）在这台 Mac 上安装 Harness Anything 和 DeepSeek Harness 插件：已装的直接复用，缺哪个 skill 补哪个，不要覆盖我改过的 skill，装完逐项验证并告诉我结果。`,
        },
        {
          title: "skill 装在哪",
          body: "用 `ha-ceo` 或 `ha-worker` 预设时，全部 Harness skill 已随插件自带，不用另装。想在别的预设里也用，让 Agent 补装到 DSH 的用户 skill 目录：",
          say: `用 harness-dsh-install skill（${skillUrl("harness-dsh-install")}）把 Harness 的全部 skill 补装到 DSH 的用户 skill 目录，已有的不要覆盖。`,
        },
        {
          title: "确认装好了",
          say: "列出你现在能用的 skill 里所有以 harness- 或 create- 开头的名字。",
        },
      ],
    },
    {
      id: "skills",
      title: "什么时候用哪个 skill",
      intro: "不用记命令。告诉 Agent 用哪个 skill、要做什么，它会自己跑。",
      items: [
        {
          title: "第一次把仓库接入 Harness",
          tag: "harness-install",
          say: `用 harness-install skill（${skillUrl("harness-install")}）把当前仓库接入 Harness Anything。`,
        },
        {
          title: "提需求、拆任务、派人、验收",
          tag: "harness-ceo",
          body: "日常最常用的一个。",
          say: `用 harness-ceo skill（${skillUrl("harness-ceo")}）接手这个需求：<写你的需求>。先建任务、写计划，给我看过再派工。`,
        },
        {
          title: "仓库里的台账是旧版本",
          tag: "harness-migration",
          say: `用 harness-migration skill（${skillUrl("harness-migration")}）检查这个仓库的台账需不需要迁移，需要就迁移，迁移前先给我看方案。`,
        },
        {
          title: "把一套固定做法教给 Agent",
          tag: "create-skill",
          say: `用 create-skill skill（${skillUrl("create-skill")}）为这个仓库写一个 skill：<描述这套做法>。`,
        },
        {
          title: "新建或调整一个 Agent",
          tag: "create-agent",
          say: `用 create-agent skill（${skillUrl("create-agent")}）为这个仓库建一个 Agent：<它负责什么>。`,
        },
        {
          title: "安装或补装 Harness",
          tag: "harness-dsh-install",
          body: "见「开始使用」页的「一键安装」。",
        },
      ],
    },
    {
      id: "first-run",
      title: "第一次完整走一遍",
      numbered: true,
      items: [
        {
          title: "新建会话，打开完全权限",
          body: "新建会话，文件夹选你的仓库。把会话权限切到「完全权限」：Agent 要直接运行 `ha` 命令，别的权限会被拦下。",
        },
        {
          title: "预设选 `ha-ceo`",
          body: "`ha-ceo` 负责规划、派工和验收，不会直接改你的代码。",
        },
        {
          title: "仓库还没接入的话，先接入",
          body: "完成后仓库里会出现 `harness/` 目录。已经接入的跳过这一步。",
          say: `用 harness-install skill（${skillUrl("harness-install")}）把当前仓库接入 Harness Anything。`,
        },
        {
          title: "提一个真实需求",
          body: "Agent 会建任务、写计划，并告诉你任务编号（形如 `task_…`）。",
          say: `用 harness-ceo skill（${skillUrl("harness-ceo")}）接手这个需求：<写你的需求>。先建任务、写计划，给我看过再派工。`,
        },
        {
          title: "打开看板看任务",
          body: "点本页右上角「在这里打开」，看板就显示在这一页；想一边对话一边看，点「在会话旁打开」。刚建的任务就在里面，任务往下走，看板会跟着变。",
        },
        {
          title: "同意计划，让它派工",
          say: "计划可以，派工吧。做完告诉我。",
        },
        {
          title: "验收交付",
          body: "执行者交付后，让 CEO 给你讲清楚再决定。",
          say: "验收 <任务编号>：讲清楚改了什么、怎么验证的、还有什么风险。",
        },
        {
          title: "确认结项",
          say: "可以，把 <任务编号> 收尾结项。",
        },
      ],
    },
    {
      id: "presets",
      title: "ha-ceo 和 ha-worker 选哪个",
      items: [
        {
          title: "ha-ceo：平时用这个",
          body: "规划、拆任务、派工、评审、记录决定。不能直接改文件，改代码的活它会派给执行者。",
        },
        {
          title: "ha-worker：让它亲手做某个任务",
          body: "在任务分配的工作区里改代码、跑测试、提交交付。用之前先有一个建好的任务。",
          say: "你是任务 <任务编号> 的执行者。先读任务计划，做完后提交交付并告诉我。",
        },
      ],
    },
    {
      id: "usage",
      title: "常用说法",
      intro: "复制后把尖括号里的内容换成你的。",
      items: [
        {
          title: "看进度",
          say: `用 harness-ceo skill（${skillUrl("harness-ceo")}）汇报现在所有任务的进度：哪些在做、哪些卡住、哪些等我决定。`,
        },
        { title: "接着上次做", say: "继续推进 <任务编号>，先读台账里的进度再动手。" },
        {
          title: "拆一个大需求",
          say: `用 harness-ceo skill（${skillUrl("harness-ceo")}）把这个需求拆成几个能单独验收的任务：<需求>。`,
        },
        { title: "任务卡住了", say: "<任务编号> 卡住了，查清原因，给我一个处理方案，先别动手。" },
        { title: "记下一个决定", say: "把这个决定记进台账：<决定>，理由是 <理由>。" },
        { title: "验收", say: "验收 <任务编号>：讲清楚改了什么、怎么验证的、还有什么风险。" },
      ],
    },
    {
      id: "trouble",
      title: "出问题怎么办",
      items: [
        {
          title: "面板提示 `ha_unavailable`",
          body: "插件找不到或启动不了 `ha`，提示后面跟着具体原因。先确认 `ha` 能用；不能用就走「一键安装」；能用的话，确认会话文件夹是已接入的仓库。",
          say: "运行 ha --version，再检查当前文件夹有没有 harness/harness.yaml，告诉我结果。",
        },
        {
          title: "面板提示 `broker_unavailable`",
          body: "插件后台没响应。重启 DeepSeek Harness 再点一次「在这里打开」。",
        },
        {
          title: "Agent 说找不到 `ha` 命令",
          body: "DSH 没拿到终端里的 PATH。",
          say: `用 harness-dsh-install skill（${skillUrl("harness-dsh-install")}）检查为什么 DSH 里找不到 ha，并修好 PATH。`,
        },
        {
          title: "Agent 每条命令都要你批准，或被拒绝",
          body: "会话权限不是「完全权限」。切过去再让它重试。",
        },
        {
          title: "提示仓库没有初始化",
          body: "这个文件夹还没接入 Harness。",
          say: `用 harness-install skill（${skillUrl("harness-install")}）把当前仓库接入 Harness Anything。`,
        },
        {
          title: "面板提示 `daemon_start_failed`",
          body: "Harness 的后台服务起不来。",
          say: "运行 ha daemon status，把报错原样告诉我，再按报错处理。",
        },
        {
          title: "面板提示其他代码，比如 `gui_build_failed`",
          body: "代码后面那句话写了怎么修。把整条提示发给 Agent：",
          say: "Harness 面板提示：<粘贴整条提示>。按提示修好，然后告诉我。",
        },
        {
          title: "预设列表里没有 `ha-ceo`",
          body: "插件没有装进你正在用的 DSH 配置。重新走「一键安装」，安装时选你正在用的那个。",
        },
        {
          title: "右侧没有打开，或是空白",
          body: "再点一次「在这里打开」。仍然空白就重启 DeepSeek Harness。",
        },
      ],
    },
    {
      id: "customize",
      title: "按你的仓库定制",
      intro: "同一套做法你跟 Agent 讲到第三遍，就该写成 skill；想让不同 Agent 各管一摊，就配 Agent。",
      numbered: true,
      items: [
        {
          title: "写一个仓库专用 skill",
          tag: "create-skill",
          body: "比如发布流程、测试命令、代码规范。Agent 会先读仓库现有的脚本和文档，写到仓库的 `skills/<名字>/SKILL.md`，写好给你看。",
          say: `用 create-skill skill（${skillUrl("create-skill")}）为这个仓库写一个 skill：<这套做法>。先读仓库现有的脚本和文档，写好给我看。`,
        },
        {
          title: "配一个执行者和一个评审员",
          tag: "create-agent",
          body: "执行者负责改代码，权限给「工作区内修改」；评审员只读不改，权限给「只读」。声明文件写在 `harness/agents/<id>.json`，刚写的 skill 也挂在这里。",
          say: `用 create-agent skill（${skillUrl("create-agent")}）为这个仓库建两个 Agent：一个执行者负责实现，挂上 <skill 名>；一个评审员只读评审。写好先校验，再给我看。`,
        },
        {
          title: "校验并安装",
          body: "Agent 会替你跑这两条。先校验，确认没问题再安装：",
          command:
            "ha agent validate --source harness/agents/<id>.json\nha agent install --source harness/agents/<id>.json",
        },
        {
          title: "选在哪台机器、哪个模型上跑",
          body: "下面的命令列出本机可用的运行实例。一般不用固定实例，Harness 会按 Agent 的声明自动挑；只有必须用某个模型时，才在声明里写死。",
          command: "ha runtime instance list",
        },
        {
          title: "检查结果",
          command: "ha agent list",
        },
      ],
    },
    {
      id: "limits",
      title: "这个面板做不到的事",
      items: [
        {
          body: "实时流、终端和原生文件在插件内嵌的看板里不可用，这是内嵌方式的限制。需要完整功能时，在终端运行下面的命令打开 Harness 自己的桌面窗口。两边看到的是同一份台账，可以同时开着。",
          command: "ha gui",
        },
      ],
    },
  ],
};

const en: TutorialCopy = {
  title: "Harness Anything",
  lead: "Let an Agent turn requests into tasks, hand them out, and check the results, with every step recorded in your repository's ledger. This page takes you from zero to your first finished task.",
  openHere: "Open here",
  openBeside: "Open beside session",
  openHint:
    "The board shows the ledger of this session's folder. To chat and watch it side by side, choose “Open beside session”.",
  backToTutorial: "← Tutorial",
  opening: "Opening Harness…",
  retry: "Retry",
  askDefault: "Show the board right away next time you open the plugin?",
  askYes: "Yes, board by default",
  askNo: "No, tutorial first",
  copy: "Copy",
  copied: "Copied",
  sayLabel: "Send to Agent",
  commandLabel: "Command",
  contents: "Contents",
  next: "Next:",
  tabs: ["Get started", "Your first run", "Which skill", "Troubleshooting", "Tailor it"],
  sections: [
    {
      id: "what",
      title: "What this is",
      items: [
        {
          body: "Harness Anything is a project ledger for Agents. Tasks, decisions, and review results live in your repository's `harness/` folder, and Agents read and write it with the `ha` command.",
        },
        {
          title: "Source repository",
          body: "Harness's source, every skill, and the install guide live here. Every phrase below includes the address of the skill it uses, so the Agent can follow it even if the skill is not installed locally.",
          command: REPOSITORY_URL,
        },
        {
          body: "This plugin does three things: it adds the `ha-ceo` and `ha-worker` presets, ships every Harness skill, and opens the Harness board on the right. The board shows exactly what Agents wrote to the ledger.",
        },
      ],
    },
    {
      id: "check",
      title: "Before you start: check three things",
      numbered: true,
      items: [
        {
          title: "The plugin is installed",
          body: "You are reading this page, so the plugin is installed in this DSH. The session preset list should include `ha-ceo` and `ha-worker`.",
        },
        {
          title: "The `ha` command works",
          body: "Start a session, switch permission to Full access, and send the sentence below. A version number means you are set. If the command is missing, see the “Install Harness and every skill” column.",
          say: "Run ha --version and ha daemon status, and show me the output as is.",
        },
        {
          title: "The repository uses Harness",
          body: "If the repository root has `harness/harness.yaml`, it is set up. If not, see step 3 of “Your first run”.",
        },
      ],
    },
    {
      id: "install",
      title: "Install Harness and every skill",
      intro:
        "If `ha` is missing or you are on a new Mac, send this to the Agent. Anything already installed is reused, not reinstalled.",
      items: [
        {
          tag: "harness-dsh-install",
          say: `Use the harness-dsh-install skill (${skillUrl("harness-dsh-install")}) to install Harness Anything and the DeepSeek Harness plugin on this Mac. Reuse whatever is already installed, add only missing skills, do not overwrite skills I changed, then verify each part and report.`,
        },
        {
          title: "Where skills live",
          body: "With the `ha-ceo` or `ha-worker` preset, every Harness skill ships with the plugin, so there is nothing to install. To use them in other presets, ask the Agent to add them to DSH's user skill folder:",
          say: `Use the harness-dsh-install skill (${skillUrl("harness-dsh-install")}) to add every Harness skill to DSH's user skill folder without overwriting existing ones.`,
        },
        {
          title: "Confirm they are installed",
          say: "List every skill you can use whose name starts with harness- or create-.",
        },
      ],
    },
    {
      id: "skills",
      title: "Which skill to use when",
      intro: "No commands to memorize. Tell the Agent which skill to use and what you want; it runs the rest.",
      items: [
        {
          title: "Set up a repository for Harness",
          tag: "harness-install",
          say: `Use the harness-install skill (${skillUrl("harness-install")}) to set up this repository for Harness Anything.`,
        },
        {
          title: "Plan, split, assign, and accept work",
          tag: "harness-ceo",
          body: "The one you will use most.",
          say: `Use the harness-ceo skill (${skillUrl("harness-ceo")}) to take this request: <your request>. Create the task and a plan, and show me the plan before assigning work.`,
        },
        {
          title: "The repository's ledger is from an older version",
          tag: "harness-migration",
          say: `Use the harness-migration skill (${skillUrl("harness-migration")}) to check whether this repository's ledger needs migrating. If it does, show me the plan before migrating.`,
        },
        {
          title: "Teach the Agent a routine",
          tag: "create-skill",
          say: `Use the create-skill skill (${skillUrl("create-skill")}) to write a skill for this repository: <describe the routine>.`,
        },
        {
          title: "Create or change an Agent",
          tag: "create-agent",
          say: `Use the create-agent skill (${skillUrl("create-agent")}) to create an Agent for this repository: <what it is responsible for>.`,
        },
        {
          title: "Install or repair Harness",
          tag: "harness-dsh-install",
          body: "See “Install Harness and every skill” on the Get started tab.",
        },
      ],
    },
    {
      id: "first-run",
      title: "Your first run",
      numbered: true,
      items: [
        {
          title: "Start a session with Full access",
          body: "Start a session on your repository folder and set its permission to Full access. The Agent runs `ha` directly, and other modes block it.",
        },
        {
          title: "Choose the `ha-ceo` preset",
          body: "`ha-ceo` plans, assigns, and accepts work. It never edits your code directly.",
        },
        {
          title: "Set up the repository if needed",
          body: "Afterwards the repository has a `harness/` folder. Skip this step if it already does.",
          say: `Use the harness-install skill (${skillUrl("harness-install")}) to set up this repository for Harness Anything.`,
        },
        {
          title: "Give it a real request",
          body: "The Agent creates a task, writes a plan, and tells you the task id (it looks like `task_…`).",
          say: `Use the harness-ceo skill (${skillUrl("harness-ceo")}) to take this request: <your request>. Create the task and a plan, and show me the plan before assigning work.`,
        },
        {
          title: "Open the board",
          body: "Click “Open here” at the top right to show the board on this page, or “Open beside session” to watch it while you chat. The new task is there, and the board updates as it moves.",
        },
        {
          title: "Approve the plan",
          say: "The plan looks good. Assign the work and tell me when it is done.",
        },
        {
          title: "Check the delivery",
          body: "When the work is delivered, have the CEO walk you through it before you decide.",
          say: "Review <task id>: what changed, how it was verified, and what risks remain.",
        },
        {
          title: "Close it",
          say: "Approved. Wrap up and close <task id>.",
        },
      ],
    },
    {
      id: "presets",
      title: "ha-ceo or ha-worker",
      items: [
        {
          title: "ha-ceo: your default",
          body: "Plans, splits tasks, assigns work, reviews, and records decisions. It cannot edit files; it hands code changes to a worker.",
        },
        {
          title: "ha-worker: do one task by hand",
          body: "Edits code, runs tests, and submits the delivery inside the task's assigned workspace. Create the task first.",
          say: "You are the worker for task <task id>. Read the task plan, then submit the delivery and tell me when done.",
        },
      ],
    },
    {
      id: "usage",
      title: "Everyday phrases",
      intro: "Copy, then replace the parts in angle brackets.",
      items: [
        {
          title: "Check progress",
          say: `Use the harness-ceo skill (${skillUrl("harness-ceo")}) to report progress on every task: what is moving, what is stuck, and what needs my decision.`,
        },
        {
          title: "Pick up where you left off",
          say: "Continue <task id>. Read its progress in the ledger before doing anything.",
        },
        {
          title: "Split a large request",
          say: `Use the harness-ceo skill (${skillUrl("harness-ceo")}) to split this request into tasks that can each be accepted on their own: <request>.`,
        },
        {
          title: "A task is stuck",
          say: "<task id> is stuck. Find out why and propose a fix, but do not change anything yet.",
        },
        { title: "Record a decision", say: "Record this decision in the ledger: <decision>, because <reason>." },
        { title: "Accept work", say: "Review <task id>: what changed, how it was verified, and what risks remain." },
      ],
    },
    {
      id: "trouble",
      title: "When something goes wrong",
      items: [
        {
          title: "The panel shows `ha_unavailable`",
          body: "The plugin cannot find or start `ha`; the reason follows the code. Check that `ha` works; if not, run “Install Harness and every skill”. If it does, make sure the session folder is a repository that uses Harness.",
          say: "Run ha --version, check whether this folder has harness/harness.yaml, and tell me the result.",
        },
        {
          title: "The panel shows `broker_unavailable`",
          body: "The plugin's background service did not answer. Restart DeepSeek Harness and click “Open here” again.",
        },
        {
          title: "The Agent cannot find the `ha` command",
          body: "DSH did not inherit your terminal's PATH.",
          say: `Use the harness-dsh-install skill (${skillUrl("harness-dsh-install")}) to find out why DSH cannot find ha, and fix the PATH.`,
        },
        {
          title: "Every command needs approval or gets refused",
          body: "The session permission is not Full access. Switch it and ask the Agent to retry.",
        },
        {
          title: "The repository is not initialized",
          body: "This folder is not set up for Harness yet.",
          say: `Use the harness-install skill (${skillUrl("harness-install")}) to set up this repository for Harness Anything.`,
        },
        {
          title: "The panel shows `daemon_start_failed`",
          body: "Harness's background service could not start.",
          say: "Run ha daemon status, show me the error as is, then fix what it reports.",
        },
        {
          title: "The panel shows another code, such as `gui_build_failed`",
          body: "The sentence after the code says how to fix it. Send the whole message to the Agent:",
          say: "The Harness panel says: <paste the whole message>. Fix it as it says, then tell me.",
        },
        {
          title: "`ha-ceo` is missing from the preset list",
          body: "The plugin is not installed in the DSH profile you are using. Run “Install Harness and every skill” again and pick the profile you use.",
        },
        {
          title: "Nothing opens on the right, or it is blank",
          body: "Click “Open here” again. If it stays blank, restart DeepSeek Harness.",
        },
      ],
    },
    {
      id: "customize",
      title: "Tailor it to your repository",
      intro:
        "Once you explain the same routine to an Agent a third time, make it a skill. When different jobs need different Agents, configure Agents.",
      numbered: true,
      items: [
        {
          title: "Write a skill for this repository",
          tag: "create-skill",
          body: "For example your release steps, test commands, or code conventions. The Agent reads the repository's scripts and docs first, writes `skills/<name>/SKILL.md`, and shows it to you.",
          say: `Use the create-skill skill (${skillUrl("create-skill")}) to write a skill for this repository: <the routine>. Read the existing scripts and docs first, and show it to me when done.`,
        },
        {
          title: "Set up a worker and a reviewer",
          tag: "create-agent",
          body: "The worker changes code and gets Workspace Write. The reviewer only reads and gets Read Only. Declarations live in `harness/agents/<id>.json`, which is also where you attach the skill you just wrote.",
          say: `Use the create-agent skill (${skillUrl("create-agent")}) to create two Agents for this repository: a worker that implements, with <skill name> attached, and a read-only reviewer. Validate them, then show me.`,
        },
        {
          title: "Validate and install",
          body: "The Agent runs these for you. Validate first, then install:",
          command:
            "ha agent validate --source harness/agents/<id>.json\nha agent install --source harness/agents/<id>.json",
        },
        {
          title: "Pick where and on which model it runs",
          body: "This lists the runtime instances on this machine. Usually you leave the instance out and Harness picks one from the Agent's declaration; pin one only when a specific model is required.",
          command: "ha runtime instance list",
        },
        {
          title: "Check the result",
          command: "ha agent list",
        },
      ],
    },
    {
      id: "limits",
      title: "What this panel cannot do",
      items: [
        {
          body: "Live streams, terminals, and native files are unavailable in the embedded board; that is a limit of embedding. For the full experience, run this in a terminal to open Harness's own desktop window. Both show the same ledger and can stay open together.",
          command: "ha gui",
        },
      ],
    },
  ],
};

/**
 * Tabs and the sections each one lays out side by side; the number is how many
 * card columns a section spans, so every tab fills a wide screen.
 */
export const TUTORIAL_LAYOUT: readonly (readonly (readonly [string, number])[])[] = [
  [
    ["what", 1],
    ["check", 1],
    ["install", 1],
  ],
  [
    ["first-run", 2],
    ["presets", 1],
  ],
  [
    ["skills", 2],
    ["usage", 2],
  ],
  [
    ["trouble", 3],
    ["limits", 1],
  ],
  [["customize", 3]],
];

export const tutorialCopy = { zh, en } as const;
export type TutorialLanguage = keyof typeof tutorialCopy;
