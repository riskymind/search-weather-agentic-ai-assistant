"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getHealth, isAbortError } from "@/lib/api";

export type BackendStatus = "checking" | "online" | "offline";

/** Checks `GET /api/health` (proxied to the backend health endpoint) on mount and on demand. */
export function useBackendHealth() {
  const [status, setStatus] = useState<BackendStatus>("checking");
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback((controller: AbortController) => {
    getHealth(controller.signal)
      .then(() => setStatus("online"))
      .catch((error: unknown) => {
        if (!isAbortError(error)) setStatus("offline");
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    run(controller);
    return () => controller.abort();
  }, [run]);

  const recheck = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus("checking");
    run(controller);
  }, [run]);

  return { status, recheck };
}
