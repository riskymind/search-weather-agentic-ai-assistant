"use client";

import dynamic from "next/dynamic";

/**
 * The chat app reads localStorage (history, theme) during its first render, so it is
 * rendered on the client only; the server sends a lightweight placeholder.
 */
const ChatApp = dynamic(() => import("@/components/ChatApp"), {
  ssr: false,
  loading: () => <AppPlaceholder />,
});

function AppPlaceholder() {
  return (
    <div className="flex h-dvh bg-bg" aria-busy="true">
      <div className="hidden w-72 border-r border-line bg-surface/70 lg:block" />
      <div className="flex flex-1 items-center justify-center text-sm text-muted">Loading…</div>
    </div>
  );
}

export function ClientApp({ accessGateEnabled = false }: { accessGateEnabled?: boolean }) {
  return <ChatApp accessGateEnabled={accessGateEnabled} />;
}
