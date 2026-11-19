import { useClientSettings } from "~/hooks/useSettings";

import { parseDefaultBudget } from "./agentdVisibility.logic";

/** Settings → Workers as Hand to a worker reads them; a per-task choice still overrides. */
export function useWorkerDefaults() {
  const runTasksOn = useClientSettings((settings) => settings.agentdRunTasksOn);
  const budget = useClientSettings((settings) => settings.agentdDefaultBudget);
  return { runTasksOn, budget: parseDefaultBudget(budget) };
}
