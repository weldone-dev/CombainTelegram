import { SettingsShell } from "../../../components/settings/settings-shell";
import { WorkflowsPage } from "../../../components/workflows/workflows-page";

export default function SettingsWorkflowsRoute() {
  return (
    <SettingsShell>
      <WorkflowsPage />
    </SettingsShell>
  );
}
