import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";

import { BrandMark } from "@/components/BrandMark";
import { ConversationList } from "@/components/ConversationList";
import type { Conversation } from "@/lib/chat";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** Settings panel slot. */
  settings: ReactNode;
  /** Present when rendered inside the mobile drawer. */
  onClose?: () => void;
}

export function Sidebar({
  conversations,
  activeId,
  onNewConversation,
  onSelectConversation,
  onDeleteConversation,
  settings,
  onClose,
}: SidebarProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <BrandMark className="size-7" />
        <span className="flex-1 font-display text-[1.05rem] font-semibold tracking-tight">Search + Weather</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close conversations"
            className="focus-ring grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={onNewConversation}
          className="focus-ring flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2"
        >
          <Plus className="size-4" aria-hidden="true" />
          New conversation
        </button>
      </div>

      <nav aria-label="Conversations" className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <h2 className="px-3 pb-1.5 text-xs text-muted">Recent</h2>
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          onSelect={onSelectConversation}
          onDelete={onDeleteConversation}
        />
      </nav>

      {settings}
    </div>
  );
}
