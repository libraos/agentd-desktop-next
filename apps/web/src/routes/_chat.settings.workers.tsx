import { createFileRoute } from "@tanstack/react-router";

import { WorkersSettings } from "../components/agentd/WorkersSettings";

export const Route = createFileRoute("/_chat/settings/workers")({
  component: WorkersSettings,
});
