// harness-test-tier: fast
import { beforeAll, describe, expect, it } from "vitest";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { actorDisplayName } from "../src/renderer/model/actor-name.ts";

beforeAll(() => setActiveLocale("zh-CN"));

describe("actorDisplayName（身份串 → 可读名字,视觉基线 v2）", () => {
  it("CLI 会话身份转成会话名,完整串保留在 full", () => {
    expect(actorDisplayName("agent:claude-session:0e6912ab")).toMatchObject({
      name: "Claude 会话",
      full: "agent:claude-session:0e6912ab",
    });
    expect(actorDisplayName("agent:codex-session:0e6912ab").name).toBe("Codex 会话");
    // daemon 派工链上的执行者 id 不带 agent: 前缀,同样识别。
    expect(actorDisplayName("runtime-session:runtime_8f7").name).toBe("运行时会话");
  });

  it("未登记的会话种类按「<种类> 会话」拼,不猜语义", () => {
    expect(actorDisplayName("agent:zai-session:abcd").name).toBe("zai-session 会话");
  });

  it("person id 去命名空间前缀;识别不了的身份如实回落原串", () => {
    expect(actorDisplayName("person_zeyu").name).toBe("zeyu");
    expect(actorDisplayName("person/zeyu").name).toBe("zeyu");
    expect(actorDisplayName("答复人甲").name).toBe("答复人甲");
  });

  it("决策行的 {kind,id} actor 与拼好的串走同一套推导", () => {
    expect(actorDisplayName({ kind: "agent", id: "claude-session:0e69" }).name).toBe("Claude 会话");
    expect(actorDisplayName({ kind: "human", id: "person_zeyu" }).name).toBe("zeyu");
  });
});
