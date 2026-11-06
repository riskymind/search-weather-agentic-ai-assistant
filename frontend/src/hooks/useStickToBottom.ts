"use client";

import { useCallback, useEffect, useRef } from "react";

const PIN_THRESHOLD_PX = 96;

/**
 * Keeps a scroll container pinned to the bottom as content grows, unless the user has
 * scrolled up to read earlier messages. `pin()` re-pins (e.g. after sending).
 */
export function useStickToBottom<T extends HTMLElement>(contentKey: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [contentKey]);

  const pin = useCallback(() => {
    pinned.current = true;
  }, []);

  return { ref, pin };
}
