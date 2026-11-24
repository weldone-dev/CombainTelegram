import { LinkedSettingsSection } from "../../../components/settings/linked-settings-section";

export default function SettingsAccountsRoute() {
  return (
    <LinkedSettingsSection
      title="Аккаунты"
      description="Подключённые аккаунты, сессии, устройства и профили."
      pageHref="/accounts"
      pageLabel="Аккаунты"
    />
  );
}
