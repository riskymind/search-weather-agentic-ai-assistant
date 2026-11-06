import { connection } from "next/server";

import { ClientApp } from "@/components/ClientApp";
import { getGateConfig } from "@/server/config";

export default async function Home() {
  // Rendered per request: the gate configuration is read from the runtime environment.
  await connection();
  return <ClientApp accessGateEnabled={getGateConfig().mode === "enabled"} />;
}
