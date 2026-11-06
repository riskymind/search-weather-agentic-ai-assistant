import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";

import type { ActivityStep } from "@/lib/activity";

const ICONS = {
  running: <LoaderCircle className="size-4 animate-spin text-accent" aria-hidden="true" />,
  done: <CircleCheck className="size-4 text-accent" aria-hidden="true" />,
  failed: <CircleAlert className="size-4 text-danger" aria-hidden="true" />,
};

const STATUS_TEXT = { running: "in progress", done: "done", failed: "failed" };

/** One step of agent activity: a tool call or a lifecycle stage. */
export function ToolExecutionCard({ step }: { step: ActivityStep }) {
  return (
    <li className="flex items-start gap-2.5 py-1" data-status={step.status}>
      <span className="mt-0.5 shrink-0">{ICONS[step.status]}</span>
      <span className="min-w-0 text-sm">
        <span className={step.status === "running" ? "text-ink" : "text-muted"}>{step.label}</span>
        <span className="sr-only">, {STATUS_TEXT[step.status]}</span>
        {step.detail && <span className="block truncate text-xs text-muted">{step.detail}</span>}
      </span>
    </li>
  );
}
