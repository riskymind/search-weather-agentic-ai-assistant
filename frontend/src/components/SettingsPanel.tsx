"use client";

import { ChevronDown, LogOut, Monitor, Moon, RefreshCw, Settings, Sun } from "lucide-react";
import { useId, useState } from "react";

import type { BackendStatus } from "@/hooks/useBackendHealth";
import type { ThemePreference } from "@/hooks/useTheme";

const THEMES: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const STATUS = {
  checking: { text: "Checking the assistant service…", dot: "bg-muted animate-pulse" },
  online: { text: "Assistant service is online", dot: "bg-accent" },
  offline: { text: "Can't reach the assistant service", dot: "bg-danger" },
} satisfies Record<BackendStatus, { text: string; dot: string }>;

interface SettingsPanelProps {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  backendStatus: BackendStatus;
  onRecheckBackend: () => void;
  onClearAll: () => void;
  hasConversations: boolean;
  accessGateEnabled?: boolean;
}

export function SettingsPanel({
  theme,
  onThemeChange,
  backendStatus,
  onRecheckBackend,
  onClearAll,
  hasConversations,
  accessGateEnabled = false,
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const status = STATUS[backendStatus];

  return (
    <div className="border-t border-line p-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-ink"
      >
        <Settings className="size-4" aria-hidden="true" />
        <span className="flex-1 text-left">Settings</span>
        <span className={`size-2 rounded-full ${status.dot}`} aria-hidden="true" />
        <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {open && (
        <div id={panelId} className="space-y-4 px-3 pt-2 pb-3 text-sm">
          <fieldset>
            <legend className="mb-1.5 text-xs text-muted">Appearance</legend>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-1">
              {THEMES.map(({ value, label, icon: Icon }) => (
                <label
                  key={value}
                  className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
                    theme === value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
                  }`}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={value}
                    checked={theme === value}
                    onChange={() => onThemeChange(value)}
                    className="sr-only"
                  />
                  <Icon className="size-3.5" aria-hidden="true" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <p className="mb-1 text-xs text-muted">Connection</p>
            <div className="flex items-center gap-2">
              <span className={`size-2 shrink-0 rounded-full ${status.dot}`} aria-hidden="true" />
              <span className="min-w-0 flex-1" role="status">
                {status.text}
              </span>
              <button
                type="button"
                onClick={onRecheckBackend}
                aria-label="Check the connection again"
                className="focus-ring grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs text-muted">History</p>
            <p className="text-xs leading-relaxed text-muted">
              Conversations are saved in this browser only. They aren&apos;t synced to other devices, and the
              assistant forgets earlier context when its server restarts.
            </p>
            <button
              type="button"
              disabled={!hasConversations}
              onClick={() => {
                if (window.confirm("Delete all conversations from this browser? This can't be undone.")) onClearAll();
              }}
              className="focus-ring mt-2 rounded-md px-2 py-1 text-xs font-medium text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              Delete all conversations
            </button>
          </div>

          {accessGateEnabled && (
            <form method="post" action="/api/access/logout">
              <p className="mb-1 text-xs text-muted">Access</p>
              <button
                type="submit"
                className="focus-ring inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-ink"
              >
                <LogOut className="size-3.5" aria-hidden="true" />
                Sign out of this demo
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
