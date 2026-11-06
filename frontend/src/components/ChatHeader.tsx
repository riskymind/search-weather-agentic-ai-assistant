import { Menu, Trash2 } from "lucide-react";

interface ChatHeaderProps {
  title: string;
  onOpenSidebar: () => void;
  onClear?: () => void;
  clearDisabled?: boolean;
}

export function ChatHeader({ title, onOpenSidebar, onClear, clearDisabled }: ChatHeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label="Open conversations"
        className="focus-ring grid size-9 place-items-center rounded-lg hover:bg-surface-2 lg:hidden"
      >
        <Menu className="size-5" aria-hidden="true" />
      </button>
      <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          disabled={clearDisabled}
          className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Trash2 className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Clear conversation</span>
          <span className="sr-only sm:hidden">Clear conversation</span>
        </button>
      )}
    </header>
  );
}
