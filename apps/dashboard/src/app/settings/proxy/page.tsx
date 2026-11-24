import { redirect } from "next/navigation";

/** The settings area is AI-only now; keep old bookmarks working. */
export default function SettingsProxyRoute() {
  redirect("/settings/ai");
}
