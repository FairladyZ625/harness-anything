import { useEffect, useState, type FormEvent } from "react";
import type { AccessAdminApi, AccessGrantsReply } from "@harness-anything/authorization-gui/access-admin-contract";
import { Button } from "../components/primitives/Button.tsx";
import { Section } from "../components/primitives/Section.tsx";
import { TextInput } from "../components/primitives/TextInput.tsx";
import { t } from "../i18n/index.tsx";

export function CredentialManagementTab({
  access,
  personId,
  canChangeOwn,
  canResetOthers,
}: {
  readonly access: AccessAdminApi;
  readonly personId: string;
  readonly canChangeOwn: boolean;
  readonly canResetOthers: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [target, setTarget] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [people, setPeople] = useState<AccessGrantsReply["people"]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    if (!canResetOthers) return;
    let current = true;
    void access.grants().then(
      (reply) => {
        if (current && reply.ok) {
          const others = reply.people.filter((person) => person.personId !== personId);
          setPeople(others);
          setTarget((selected) => (others.some((person) => person.personId === selected) ? selected : ""));
        }
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [access, canResetOthers, personId]);

  const changeOwnPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) {
      setFeedback(t("identityAccess.passwordMismatch"));
      return;
    }
    setBusy(true);
    const result = await access.changePassword({ password }).catch(() => ({ ok: false as const }));
    setFeedback(result.ok ? t("identityAccess.passwordChanged") : t("identityAccess.passwordFailed"));
    setPassword("");
    setConfirmation("");
    setBusy(false);
  };

  const resetAnotherPassword = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await access
      .resetPassword({ personId: target, password: resetPassword })
      .catch(() => ({ ok: false as const }));
    setFeedback(result.ok ? t("identityAccess.passwordReset") : t("identityAccess.passwordFailed"));
    setResetPassword("");
    setBusy(false);
  };

  return (
    <div className="min-w-0">
      {feedback ? (
        <p role="status" className="mb-3 ui-meta text-text-muted">
          {feedback}
        </p>
      ) : null}
      {canChangeOwn ? (
        <Section title={t("identityAccess.changeOwnPassword")}>
          <form className="flex max-w-xl flex-col gap-3" onSubmit={(event) => void changeOwnPassword(event)}>
            <label className="flex flex-col gap-1 ui-meta text-text-muted">
              {t("identityAccess.newPassword")}
              <TextInput
                label={t("identityAccess.newPassword")}
                type="password"
                value={password}
                onChange={setPassword}
                testId="account-new-password"
              />
            </label>
            <label className="flex flex-col gap-1 ui-meta text-text-muted">
              {t("identityAccess.confirmPassword")}
              <TextInput
                label={t("identityAccess.confirmPassword")}
                type="password"
                value={confirmation}
                onChange={setConfirmation}
                testId="account-confirm-password"
              />
            </label>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !password || !confirmation}
              testId="account-password-change"
            >
              {t("identityAccess.changePassword")}
            </Button>
          </form>
        </Section>
      ) : null}
      {canResetOthers ? (
        <Section title={t("identityAccess.resetOtherPassword")}>
          <form className="flex max-w-xl flex-col gap-3" onSubmit={(event) => void resetAnotherPassword(event)}>
            <label className="flex flex-col gap-1 ui-meta text-text-muted">
              {t("identityAccess.account")}
              <select
                aria-label={t("identityAccess.account")}
                data-testid="account-password-target"
                className="min-w-0 rounded-sm border border-border bg-surface px-2 py-1 ui-meta text-text"
                value={target}
                onChange={(event) => setTarget(event.currentTarget.value)}
              >
                <option value="">{t("identityAccess.selectAccount")}</option>
                {people.map((person) => (
                  <option key={person.personId} value={person.personId}>
                    {person.username} ({person.personId})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 ui-meta text-text-muted">
              {t("identityAccess.newPassword")}
              <TextInput
                label={t("identityAccess.newPassword")}
                type="password"
                value={resetPassword}
                onChange={setResetPassword}
                testId="account-reset-password"
              />
            </label>
            <Button
              type="submit"
              variant="danger"
              disabled={busy || !target || !resetPassword}
              testId="account-password-reset"
            >
              {t("identityAccess.resetPassword")}
            </Button>
          </form>
        </Section>
      ) : null}
    </div>
  );
}
