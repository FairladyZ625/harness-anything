import type { DaemonHost } from "./daemon-host.ts";
import type { DaemonHostApiContext } from "./daemon-host-context.ts";
import { readDaemonRegistry } from "../../kernel/src/index.ts";

export function createDaemonHostLifecycleApi(
  context: DaemonHostApiContext,
): Pick<DaemonHost, "status" | "startAttachments" | "attachmentsSettled" | "close"> {
  return {
    status: () => {
      const { entry, ...observedBuild } = context.buildObserver.status(),
        build = {
          ...observedBuild,
          version: process.env.npm_package_version ?? "0.0.0",
        },
        registry = readDaemonRegistry({ userRoot: context.input.userRoot }),
        proxyRepos = registry.repos
          .filter((repo) => repo.state === "enabled" && repo.mode === "remote-proxy")
          .map((repo) => ({
            repoId: repo.repoId,
            rootDir: "",
            mode: repo.mode,
            state: "closed" as const,
            generation: null,
            queueDepth: null,
            recoveryMs: null,
            lastError: null,
            causeClass: null,
          })),
        base = [
          "daemon status: pid=",
          `${process.pid}`,
          " repos=",
          `${context.cells.size + context.warming.size + context.unavailable.size + proxyRepos.length}`,
          " entry=",
          entry,
          " commit=",
          build.commit ?? "unknown",
          "",
        ].join(""),
        summary = observedBuild.drifted
          ? [
              "",
              `${base}`,
              " \u2014 build drift: daemon loaded dist build ",
              `${observedBuild.loadedBuildId ?? "missing"}`,
              " while disk has ",
              `${observedBuild.diskBuildId ?? "missing"}`,
              "; it will keep serving the loaded build. Run `ha daemon stop`; the next ",
              "command will autostart the disk build.",
            ].join("")
          : base;
      return {
        daemonId: context.input.daemonId,
        pid: process.pid,
        startedAt: context.startedAt,
        entry,
        build,
        connections: registry.connections,
        repos: [
          ...[...context.cells.values()].map((cell) => cell.status()),
          ...context.warming.values(),
          ...context.unavailable.values(),
          ...proxyRepos,
        ].sort((a, b) => a.repoId.localeCompare(b.repoId)),
        summary,
      };
    },
    startAttachments: () => {
      void context.startInitialAttachments();
    },
    attachmentsSettled: context.startInitialAttachments,
    close: async () => {
      context.closing = true;
      context.scheduleScheduler.close();
      if (context.initialAttachments) await context.initialAttachments;
      for (const repoId of [...context.warming.keys()]) context.settleWarming(repoId);
      if (context.fleetCenter) await context.fleetCenter.close();
      for (const runtime of context.fleetEdgeRuntimes.values()) runtime.close();
      context.fleetEdgeRuntimes.clear();
      context.remoteProxy.close();
      await Promise.all([...context.cells.values()].map((cell) => cell.close()));
    },
  };
}
