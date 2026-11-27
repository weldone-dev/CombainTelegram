import { redirect } from "next/navigation";

/** The AI-only settings area is gone; keep old bookmarks working. */
export default function SettingsRoute() {
  redirect("/eve");
}
