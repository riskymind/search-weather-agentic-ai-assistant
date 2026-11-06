import { MessageSquare, Trash2 } from "lucide-react";

import type { Conversation } from "@/lib/chat";
import { formatRelativeTime } from "@/lib/format";

interface ConversationListProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ConversationList({ conversations, activeId, onSelect, onDelete }: ConversationListProps) {
  if (conversations.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted">Your conversations will appear here.</p>;
  }

  return (
    <ul className="space-y-0.5">
      {conversations.map((conversation) => {
        const active = conversation.id === activeId;
        return (
          <li key={conversation.id} className="group relative">
            <button
              type="button"
              onClick={() => onSelect(conversation.id)}
              aria-current={active ? "page" : undefined}
              className={`focus-ring flex w-full items-start gap-2.5 rounded-lg py-2 pr-9 pl-3 text-left ${
                active ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2/70 hover:text-ink"
              }`}
            >
              <MessageSquare className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block truncate text-sm">{conversation.title}</span>
                <span className="block text-xs text-muted">{formatRelativeTime(conversation.updatedAt)}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => onDelete(conversation.id)}
              aria-label={`Delete conversation: ${conversation.title}`}
              className="focus-ring absolute top-2 right-1.5 grid size-7 place-items-center rounded-md text-muted hover:bg-surface hover:text-danger focus:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
