import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

/**
 * 实体**自己收管的内容**的读(`repo.entity.content.read`)。
 *
 * 与 `repo.entity.locator.read` 的分工是两件不同的事:locator 读的是**来源**——那个仓内
 * 路径此刻是什么样;这条读的是**实体自己的字节**——导入被接受那一刻收进来的那份,来自
 * canonical 存储而不是工作副本。来源被移动、改名或删掉之后,这一条照样读得出来。
 *
 * 寻址只用实体身份。内容落在台账的 authored root 下,而 authored root 是可配置的,所以
 * 路径由读面算好放在 `repositoryPath` 里,渲染层直接显示——这里**不拼前缀**,拼出来的
 * `harness/` 会在自定义 authored root 的仓里对用户谎报位置。
 */
export type EntityContentOutcome = "file" | "directory" | "missing" | "too-large" | "binary";

export interface EntityContentEntry {
  /** 实体内相对路径;内容根本身是空串。 */
  readonly path: string;
  readonly directory: boolean;
  readonly sizeBytes: number | null;
}

export interface EntityContentRead {
  readonly outcome: EntityContentOutcome;
  readonly entityRef: string;
  readonly path: string;
  /** 这份内容在**当前配置**下落在仓里的位置,由读面算出,不由渲染层拼。 */
  readonly repositoryPath: string;
  readonly content: string | null;
  readonly sizeBytes: number | null;
  readonly mediaType: string | null;
  readonly entries: readonly EntityContentEntry[];
  readonly truncated: boolean;
}

type ContentBridge = {
  readonly readEntityContent: (payload: {
    readonly repoId: string;
    readonly entityKind: string;
    readonly entityId: string;
    readonly path?: string;
  }) => Promise<unknown>;
};

/**
 * 内容读的 query 声明。内容根与树里每一层共用同一份 key / 读函数 / 新鲜度——两处各拼
 * 一份就会出现同一层双读。空 `path` 表示内容根:读面的 `path` 是可选参数,递一个空串会被
 * 判成非法,所以这里省略它而不是递空。
 */
export function entityContentQuery(repoId: string, entityKind: string, entityId: string, path = "") {
  return {
    queryKey: ["entity-content", repoId, entityKind, entityId, path] as const,
    queryFn: () => readEntityOwnedContent(repoId, entityKind, entityId, path),
    staleTime: 4_000,
  };
}

export async function readEntityOwnedContent(
  repoId: string,
  entityKind: string,
  entityId: string,
  path = "",
): Promise<EntityContentRead> {
  const channel = (window.harness as unknown as Partial<ContentBridge> | undefined)?.readEntityContent;
  if (!channel) throw new Error("Entity content bridge is unavailable.");
  const value = await channel({ repoId, entityKind, entityId, ...(path === "" ? {} : { path }) });
  if (!isRendererRecord(value) || value.schema !== "entity-content-read/v1" || typeof value.outcome !== "string")
    throw new Error(rendererErrorHint(value, "Entity content bridge returned an invalid result."));
  return value as unknown as EntityContentRead;
}

/**
 * 内容根打开时先落到哪个文件。只有**唯一一个文件、没有子目录**时才自动落——一份来源
 * 文件的实体因此一打开就是正文;多条目的实体不替人挑,由人点。
 */
export function soleContentFile(entries: readonly EntityContentEntry[]): string | null {
  const files = entries.filter(({ directory }) => !directory);
  return files.length === 1 && files.length === entries.length ? files[0]!.path : null;
}
