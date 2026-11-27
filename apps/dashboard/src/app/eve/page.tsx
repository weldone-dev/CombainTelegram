import type { Metadata } from "next";
import { EvePage } from "./eve-page";

export const metadata: Metadata = {
  title: "Eve · CombainTelegram",
  description: "Персоны Eve, привязки аккаунтов и allowlist чатов",
};

export default function EveRoute() {
  return <EvePage />;
}
