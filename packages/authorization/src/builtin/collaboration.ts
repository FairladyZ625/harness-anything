const pluginDocumentation = "docs-release/builtin-identity-provider.md#keycloak-plugin";

/** The one error shape used at the identity boundary for builtin collaboration calls. */
export function identityPluginRequired(): Error {
  return Object.assign(
    new Error(`这是多人/多设备协作功能，单机内置身份不支持，安装 Keycloak 插件后可用。请参阅 ${pluginDocumentation}。`),
    {
      code: "identity_plugin_required",
    },
  );
}
