import { AiSettingsSection } from "../../../components/settings/ai-settings-section";
import { SettingsShell } from "../../../components/settings/settings-shell";

export default function SettingsAiRoute() {
  return (
    <SettingsShell>
      <AiSettingsSection />
    </SettingsShell>
  );
}
