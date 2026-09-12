import type { SettingsSuccess } from "../../api-client.ts";
import { Row, SettingSelect, Toggle } from "../../components/ui/widgets.tsx";

type CloseoutSettings = SettingsSuccess["settings"]["closeout"];

/** 仓库 closeout 配置行:profile 基线 + 四个门的单点 override。
 * 生效门集合由 kernel 按 profile 收敛,这里只提交显式写下的配置。 */
export function CloseoutRows({
  closeout,
  onChange,
}: {
  readonly closeout: CloseoutSettings;
  readonly onChange: (closeout: CloseoutSettings) => void;
}) {
  return (
    <>
      <Row label="Closeout profile" desc="Choose the repository baseline for completion review gates.">
        <SettingSelect
          label="Closeout profile"
          testId="settings-closeout-profile-select"
          value={closeout.profile}
          options={[
            { value: "standard", label: "standard" },
            { value: "strict", label: "strict" },
          ]}
          onChange={(profile) => onChange({ ...closeout, profile: profile as CloseoutSettings["profile"] })}
        />
      </Row>
      {(["review", "consent", "factDisposition", "codeDoc"] as const).map((gate) => (
        <Row key={gate} label={`Closeout ${gate}`} desc="Override this closeout gate for the repository.">
          <Toggle
            checked={closeout.overrides?.[gate] ?? closeout.profile === "strict"}
            onChange={(enabled) => onChange({ ...closeout, overrides: { ...closeout.overrides, [gate]: enabled } })}
          />
        </Row>
      ))}
    </>
  );
}
