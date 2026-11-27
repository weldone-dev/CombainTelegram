import type { Metadata } from "next";
import { ContextPage } from "./context-page";

export const metadata: Metadata = {
  title: "Eve · Context",
  description:
    "Что Eve отправляет в модель: system-блоки и сообщения каждого turn'а",
};

export default function EveContextRoute() {
  return <ContextPage />;
}
