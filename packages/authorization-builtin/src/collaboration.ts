const pluginDocumentation = "docs-release/builtin-identity-provider.md#keycloak-plugin";

/** The one error shape used at the identity boundary for builtin collaboration calls. */
export function identityPluginRequired(): Error {
  return Object.assign(new Error(`需要安装身份插件（Keycloak）后使用协作功能。请参阅 ${pluginDocumentation}。`), {
    code: "identity_plugin_required",
  });
}
