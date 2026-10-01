# 隔离测试镜像

这个目录只提供一个 Docker 镜像：`plt-center-testbed/source:latest`。镜像里是本仓源码、
`npm ci` 装好的依赖、构建好的 CLI，以及 `/usr/local/bin/ha`。它不含任何拓扑：没有中心、
没有边缘、没有 Keycloak。

使用方：

- `tools/dispatch-isolated-test.mjs --target docker`：在一个全新容器里跑 integration 测试。
- `tools/scale/cli-entity-bench.mjs --docker`：在一个全新容器里跑 CLI 与实体规模基准。

两者都只把镜像当作带依赖的 Node 环境，自己把当前工作树拷进容器的 `/workspace` 再执行；
镜像不存在时它们不会代为构建。

## 构建

在仓库根目录执行：

```bash
docker build -t plt-center-testbed/source:latest -f tools/center-testbed/Dockerfile .
```

构建上下文是仓库根；`Dockerfile.dockerignore` 把 `node_modules`、`harness/`、`.worktrees`
与各包的 `dist` 挡在镜像之外，所以镜像总是从源码编译。依赖或 `package-lock.json` 变了就重建。

## 文件

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | node:24-bookworm-slim + 本仓源码 `npm ci` + CLI build |
| `Dockerfile.dockerignore` | 该 Dockerfile 专用的构建上下文排除表 |

中心加边缘的真实拓扑不在这里：中心的部署见 `tools/fleet-center/`。
