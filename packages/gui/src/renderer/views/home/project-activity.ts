import { useQueries } from "@tanstack/react-query";
import type { SystemRepoRow } from "../../api-client.ts";
import { projectActivityRead, repoReadsActivity, type ProjectActivityRead } from "../../model/repo-state.ts";
import { overviewRuntimeQuery } from "../../overview-data.ts";
import { workspaceSummaryQuery } from "../../workspace-summary-data.ts";

/**
 * 各项目的任务情况:每个已挂载项目两条有界读(工作区摘要 + runtime 概览),各自独立
 * 加载、互不阻塞,失败只影响那一个项目。key 与活动项目的常驻读面相同,当前项目直接
 * 命中缓存。未挂载、远端代理、已停用的项目不读——不为这个页面触发挂载。
 */
export function useProjectActivity(repos: ReadonlyArray<SystemRepoRow>): (repo: SystemRepoRow) => ProjectActivityRead {
  const readable = repos.filter(repoReadsActivity),
    summaries = useQueries({ queries: readable.map((repo) => workspaceSummaryQuery(repo.repoId)) }),
    runtimes = useQueries({ queries: readable.map((repo) => overviewRuntimeQuery(repo.repoId)) }),
    reads = new Map(
      readable.map((repo, index) => [repo.repoId, projectActivityRead(summaries[index]!, runtimes[index]!)] as const),
    );
  return (repo) => reads.get(repo.repoId) ?? { state: "unread" };
}
