import { readDaemonRegistry, type DaemonRegistry } from "../../../kernel/src/index.ts";
import { daemonUserRoot } from "../../../daemon/src/client/local-daemon-target.ts";

/**
 * PLT-EdgeGUI-W3:repo 作用域请求的 daemon target 解析。
 *
 * daemon 的 `resolveLocalDaemonTarget` 只认 canonicalRoot 非空的注册行 —— 那是
 * local CLI 的语义(root 必须在本机)。GUI 的 repo 作用域读只需要本机 daemon 的
 * socket:namespace 路由(local cell 或 remote-proxy 转发)由 daemon 自己按
 * `params.repo.repoId` 决定。因此对「启用中的 remote-proxy 仓」,target 直接取
 * 全局 daemon socket,daemon 侧照旧做 namespace 鉴权;其余仓保持原判定不变
 * (未注册/停用的 repoId 依旧在这里被拒,不放松 local 语义)。
 */

export interface LocalDaemonSocketTarget {
  readonly socketPath: string;
  readonly userRoot: string;
  readonly daemonId: string;
}

export type RegistryReader = () => DaemonRegistry;

export function isRemoteProxyRepo(registry: DaemonRegistry, repoId: string): boolean {
  return registry.repos.some(
    (repo) => repo.repoId === repoId && repo.mode === "remote-proxy" && repo.state === "enabled",
  );
}

/**
 * 解析失败时:仅当 repoId 是 registry v2 里启用中的 remote-proxy 仓才回退到全局
 * socket;否则原样抛出上层错误(workspace_not_registered 等)。
 *
 * registry 与全局 target 都以 thunk 传入并只在回退分支求值 —— 它们各自会抛
 * (注册表不可读、endpoint 与 userRoot 冲突),提前求值会把 strictResolve 的
 * 真实拒绝原因换成回退路径的错误,fail-closed 的错误码就此失真。
 */
export function resolveRepoScopedTarget(
  strictResolve: () => LocalDaemonSocketTarget,
  readRegistry: () => DaemonRegistry,
  globalTarget: () => LocalDaemonSocketTarget,
  repoId: string,
): LocalDaemonSocketTarget {
  try {
    return strictResolve();
  } catch (error) {
    if (!isRemoteProxyRepo(readRegistry(), repoId)) throw error;
    return globalTarget();
  }
}

/** electron-main 用的缺省装配:registry 读 kernel 的唯一事实源,userRoot 来自环境。 */
export function defaultRegistryReader(): DaemonRegistry {
  return readDaemonRegistry({ userRoot: daemonUserRoot() });
}
