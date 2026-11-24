import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient } from "../api-client.ts";
import { runtimeInstanceClient } from "../runtime-instance-client.ts";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { ActionError } from "../components/runtime/ActionError.tsx";

export function ResidentCeoView({ repoId }: { readonly repoId: string }) {
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ["resident-ceo", repoId],
    queryFn: () => harnessClient.getResidentCeo({ repoId }),
  });
  const instanceQuery = useQuery({
    queryKey: ["runtime-instances", "machine", repoId],
    queryFn: () => runtimeInstanceClient.list(repoId),
  });
  const profile = profileQuery.data?.profile ?? null;
  const instances = instanceQuery.data?.instances.filter((instance) => instance.enabled) ?? [];
  const [instanceId, setInstanceId] = useState("");
  const [model, setModel] = useState("");
  const [heartbeatIntervalSec, setHeartbeatIntervalSec] = useState("300");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const selectedInstance = instances.find((instance) => instance.instanceId === (instanceId || profile?.runtimeInstanceId));
  const models = selectedInstance?.models ?? [];
  const selectedModel = useMemo(
    () =>
      model ||
      (profile !== null && profile.runtimeInstanceId === selectedInstance?.instanceId ? profile.model : "") ||
      selectedInstance?.defaultModel ||
      models[0] ||
      "",
    [model, profile?.model, profile?.runtimeInstanceId, selectedInstance?.defaultModel, selectedInstance?.instanceId, models],
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["resident-ceo", repoId] });
  const configure = useMutation({
    mutationFn: () =>
      harnessClient.configureResidentCeo({
        repoId,
        runtimeInstanceId: instanceId || profile?.runtimeInstanceId || selectedInstance?.instanceId || "",
        model: selectedModel,
        heartbeatIntervalSec: Number(heartbeatIntervalSec),
      }),
    onSuccess: refresh,
  });
  const start = useMutation({ mutationFn: () => harnessClient.startResidentCeo({ repoId }), onSuccess: refresh });
  const stop = useMutation({ mutationFn: () => harnessClient.stopResidentCeo({ repoId }), onSuccess: refresh });
  const chat = useMutation({
    mutationFn: () => harnessClient.chatResidentCeo({ repoId, message }),
    onSuccess: (result) => {
      setReply(result.response ?? "");
      setMessage("");
      refresh();
    },
  });
  const error = profileQuery.error ?? instanceQuery.error ?? configure.error ?? start.error ?? stop.error ?? chat.error;

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6" data-testid="resident-ceo-view">
      <PageHeader title="常驻 CEO" note="配置运行实例、心跳，并与同一条持久会话续聊。" />
      {error ? <ActionError error={error} /> : null}
      <div className="rounded-xl border border-border-subtle bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="ui-heading">运行配置</h2>
          <span data-testid="resident-ceo-status">{profile?.status ?? "未配置"}</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-2 ui-body">
            Provider / Instance
            <select value={instanceId || profile?.runtimeInstanceId || ""} onChange={(event) => setInstanceId(event.target.value)}>
              <option value="">选择运行实例</option>
              {instances.map((instance) => (
                <option key={instance.instanceId} value={instance.instanceId}>{instance.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2 ui-body">
            Model
            <select value={selectedModel} onChange={(event) => setModel(event.target.value)}>
              <option value="">选择模型</option>
              {models.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-2 ui-body">
            心跳间隔（秒）
            <input
              type="number"
              min={30}
              max={86400}
              value={heartbeatIntervalSec}
              onChange={(event) => setHeartbeatIntervalSec(event.target.value)}
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            onClick={() => configure.mutate()}
            disabled={!selectedInstance || !selectedModel || !Number.isSafeInteger(Number(heartbeatIntervalSec)) || Number(heartbeatIntervalSec) < 30}
          >保存配置</Button>
          {profile?.status === "running" ? (
            <Button onClick={() => stop.mutate()}>停止</Button>
          ) : (
            <Button onClick={() => start.mutate()} disabled={!profile}>启动</Button>
          )}
        </div>
        <p className="mt-4 ui-micro text-text-muted" data-testid="resident-ceo-last-wake">
          最近唤醒：{profile?.lastWake ? `${profile.lastWake.cause} · ${profile.lastWake.status} · ${profile.lastWake.requestedAt}` : "暂无"}
        </p>
      </div>
      <form
        className="rounded-xl border border-border-subtle bg-surface p-5"
        onSubmit={(event) => { event.preventDefault(); chat.mutate(); }}
      >
        <h2 className="mb-3 ui-heading">与常驻 CEO 对话</h2>
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="发送消息并续接当前会话"
            aria-label="发送消息"
          />
          <Button type="submit" disabled={profile?.status !== "running" || message.trim().length === 0}>发送</Button>
        </div>
        {reply ? <p className="mt-4 whitespace-pre-wrap" data-testid="resident-ceo-reply">{reply}</p> : null}
      </form>
    </section>
  );
}
