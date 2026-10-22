import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { connect } from "node:tls";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { fleetCenterConfigPath } from "../../../packages/daemon/src/fleet-center-config.ts";

/**
 * 中心服务的 GUI 启动入口(task_5f97879a):邀请入口在中心服务未开时阻断并一键开启,
 * 开启走 daemon 的 daemon.fleet.center.start —— 载荷不带证书,daemon 沿用这里种下的
 * 登录服务监听证书;启动后中心面板报监听状态与对外地址,边缘真的能完成 TLS 握手。
 *
 * 种法都是真实文件面:<userRoot>/rbac/config.json 带 listener(managed 形状,和
 * edge-invite-entry 的缺证书种法同一张表),fleet/center.json 种一份「保存过但未监听」
 * 的配置(端口/绑定取探测出的空闲口,一键开启按保存值重启,不猜默认端口)。
 */
export default {
  id: "center-service-start",
  feature: "settings",
  lane: "isolated",
  description:
    "The invite entry blocks on a stopped center service and starts it in one click through daemon.fleet.center.start with the login listener certificate (no key/cert field anywhere); the center panel then shows the listening port, external address and reused certificate, and an edge-style TLS handshake against the login certificate succeeds.",
  async run({ page, app, fixture, shot }) {
    const certificateKeyFile = path.join(fixture.userRoot, "rbac", "listener", "self-signed.key"),
      certificateFile = path.join(fixture.userRoot, "rbac", "listener", "self-signed.pem");
    mkdirSync(path.dirname(certificateFile), { recursive: true });
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        certificateKeyFile,
        "-out",
        certificateFile,
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const writeJson = (file, value) => {
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
      renameSync(temporary, file);
    };
    // 登录服务监听证书:GUI 的 listener 读面因此 ready,daemon 的 start 也解析到这一对。
    const rbacPath = path.join(fixture.userRoot, "rbac", "config.json"),
      rbac = JSON.parse(readFileSync(rbacPath, "utf8"));
    writeJson(rbacPath, {
      ...rbac,
      mode: "managed",
      postgresPort: 15432,
      managementPort: 15900,
      certificateMode: "self-signed",
      listener: {
        address: "127.0.0.1",
        hostname: "localhost",
        port: 18443,
        certificateFile,
        certificateKeyFile,
      },
    });
    // 保存过但未监听:一轮启动后 daemon 停机重来就是这张表;端口探测避免占用撞车。
    const port = await unusedLoopbackPort(),
      centerConfigPath = fleetCenterConfigPath(fixture.userRoot, fixture.daemonId);
    mkdirSync(path.dirname(centerConfigPath), { recursive: true });
    writeJson(centerConfigPath, {
      schema: "fleet-center-config/v1",
      port,
      bind: "127.0.0.1",
      repoId: fixture.repoId,
      keyPath: certificateKeyFile,
      certPath: certificateFile,
      quotaBytes: 64 * 1024 * 1024,
      stateRoot: path.join(fixture.userRoot, "fleet"),
    });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
    await page
      .getByRole("dialog", { name: "Harness Anything 首次启动" })
      .getByRole("button", { name: "稍后" })
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByTestId("settings-content").waitFor();
    await page.getByRole("button", { name: /仓库与连接|Repos & connections/u }).click();
    await page.getByTestId("repositories-connections-view").waitFor();

    // 1. 邀请入口:登录证书已就绪、中心服务未开 → 阻断说明 + 一键开启,不是表单。
    await page.getByTestId("invite-entry-open").click();
    const blocked = page.getByTestId("invite-entry-blocked-service");
    await blocked.waitFor();
    assert.match(await blocked.innerText(), /中心服务|center service/u);
    assert.equal(await page.getByTestId("edge-invite-issue").count(), 0);
    await shot("center-service-invite-blocked");

    // 2. 一键开启:参数全部推导(保存的端口/绑定 + 登录主机名),证书不出现在界面上。
    await page.getByTestId("invite-entry-start-center").click();
    await page.getByTestId("edge-invite-issue").waitFor({ timeout: 30_000 });
    await shot("center-service-invite-ready");

    // 3. 中心面板:监听状态 + 端口 + 对外地址 + 证书沿用登录服务。
    await page.getByTestId("connection-node-center").click();
    const status = page.getByTestId("center-service-status");
    await status.waitFor();
    const statusText = await status.innerText();
    assert.match(statusText, new RegExp(String(port)), `status must name the listening port: ${statusText}`);
    assert.match(statusText, /https:\/\/localhost:\d+/u, `status must name the external address: ${statusText}`);
    assert.match(statusText, /登录服务|login service/u, `status must name the reused certificate: ${statusText}`);
    await shot("center-service-panel-listening");

    // 4. 真的在监听:边缘式的 TLS 握手,信任锚就是登录服务证书;daemon 读面同口径。
    await handshake(port, certificateFile);
    const state = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "daemon.fleet.center.read",
      { payload: {} },
      5_000,
      15_000,
    );
    assert.equal(state.ok, true, JSON.stringify(state));
    assert.equal(state.running, true);
    assert.equal(state.port, port);
    assert.equal(state.certificateSource, "login-listener");

    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.length > 0 && windows.every(({ visible, focused }) => !visible && !focused));
  },
};

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function handshake(port, certificateFile) {
  await new Promise((resolve, reject) => {
    const socket = connect({
      host: "localhost",
      port,
      ca: readFileSync(certificateFile),
      servername: "localhost",
    });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      socket.destroy();
      resolve();
    });
  });
}
