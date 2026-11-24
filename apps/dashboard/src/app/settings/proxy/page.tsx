import { LinkedSettingsSection } from "../../../components/settings/linked-settings-section";

export default function SettingsProxyRoute() {
  return (
    <LinkedSettingsSection
      title="Прокси"
      description="Прокси для подключения аккаунтов Telegram и проверка их доступности."
      pageHref="/proxies"
      pageLabel="Прокси"
    />
  );
}
