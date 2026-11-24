import { LinkedSettingsSection } from "../../../components/settings/linked-settings-section";

export default function SettingsLogsRoute() {
  return (
    <LinkedSettingsSection
      title="Логи"
      description="Действия HTTP, ответы Telegram, ошибки и их экспорт."
      pageHref="/logs"
      pageLabel="Логи"
    />
  );
}
