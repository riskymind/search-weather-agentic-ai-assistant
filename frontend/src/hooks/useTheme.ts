"use client";

import { useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

/** Also read by the pre-paint script in `app/layout.tsx`; keep the key in sync. */
export const THEME_STORAGE_KEY = "sw-assistant:theme";

function readPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = preference === "dark" || (preference === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // ignore
    }
    if (preference !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  return { preference, setPreference };
}
