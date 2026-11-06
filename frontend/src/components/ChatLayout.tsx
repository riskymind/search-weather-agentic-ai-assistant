"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface ChatLayoutProps {
  /** Rendered as a fixed column on large screens. */
  sidebar: ReactNode;
  /** Rendered inside the mobile drawer (usually the same sidebar with a close button). */
  drawerSidebar: ReactNode;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  header: ReactNode;
  children: ReactNode;
}

/** Responsive shell: persistent sidebar on desktop, modal drawer on tablet and mobile. */
export function ChatLayout({ sidebar, drawerSidebar, drawerOpen, onCloseDrawer, header, children }: ChatLayoutProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    drawerRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [drawerOpen, onCloseDrawer]);

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-ink">
      <aside className="hidden w-72 shrink-0 border-r border-line bg-surface/70 lg:block">{sidebar}</aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close conversations"
            tabIndex={-1}
            onClick={onCloseDrawer}
            className="absolute inset-0 animate-[fade-in_150ms_ease-out] bg-ink/30 backdrop-blur-[2px]"
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Conversations"
            className="absolute inset-y-0 left-0 w-[85%] max-w-xs animate-[slide-in_180ms_ease-out] border-r border-line bg-surface shadow-xl"
          >
            {drawerSidebar}
          </div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {header}
        {children}
      </main>
    </div>
  );
}
