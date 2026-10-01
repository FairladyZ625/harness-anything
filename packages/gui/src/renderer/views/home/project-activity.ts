import { readAgendaPage } from "../../agenda-data.ts";
import { useQueries } from "@tanstack/react-query";
import type { SystemRepoRow } from "../../api-client.ts";
import { projectActivityRead, repoReadsActivity, type ProjectActivityRead } from "../../model/repo-state.ts";
import { overviewRuntimeQuery } from "../../overview-data.ts";
import { workspaceSummaryQuery } from "../../workspace-summary-data.ts";

/**
 * 各项目的任务情况:每个已挂载项目三条有界读(工作区摘要 + runtime 概览 + 议程第一页),各自独立
 * 加载、互不阻塞,失败只影响那一个项目。摘要与 runtime 共用常驻缓存;议程第一页
 * 使用独立 key,避免混入议程页续读的结果。未挂载与已停用的项目不读,不触发挂载。
 */
export function useProjectActivity(repos: ReadonlyArray<SystemRepoRow>): (repo: SystemRepoRow) => ProjectActivityRead {
  const readable = repos.filter(repoReadsActivity),
    summaries = useQueries({ queries: readable.map((repo) => workspaceSummaryQuery(repo.repoId)) }),
    runtimes = useQueries({ queries: readable.map((repo) => overviewRuntimeQuery(repo.repoId)) }),
    agendas = useQueries({
      queries: readable.map((repo) => ({
        queryKey: ["agenda", repo.repoId, "project-first-page"],
        queryFn: () => readAgendaPage(repo.repoId, {}),
        staleTime: 10_000,
        retry: false,
      })),
    }),
    reads = new Map(
      readable.map(
        (repo, index) =>
          [
            repo.repoId,
            projectActivityRead(
              summaries[index]!,
              runtimes[index]!,
              agendas[index]!.isError ? undefined : agendas[index]!.data,
            ),
          ] as const,
      ),
    );
  return (repo) => reads.get(repo.repoId) ?? { state: "unread" };
}
