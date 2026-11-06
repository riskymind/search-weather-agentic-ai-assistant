import { CloudSun, MapPinned, Newspaper, Telescope, type LucideIcon } from "lucide-react";

export const SUGGESTED_PROMPTS: Array<{ text: string; icon: LucideIcon }> = [
  { text: "What's the current weather in Lagos?", icon: CloudSun },
  { text: "Find the latest technology news.", icon: Newspaper },
  { text: "Find the capital of Kenya and its current weather.", icon: MapPinned },
  { text: "Research the latest developments in artificial intelligence.", icon: Telescope },
];

interface SuggestedPromptsProps {
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}

export function SuggestedPrompts({ onSelect, disabled }: SuggestedPromptsProps) {
  return (
    <ul className="grid gap-2.5 sm:grid-cols-2" aria-label="Suggested questions">
      {SUGGESTED_PROMPTS.map(({ text, icon: Icon }) => (
        <li key={text}>
          <button
            type="button"
            onClick={() => onSelect(text)}
            disabled={disabled}
            className="focus-ring flex h-full w-full items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3.5 text-left text-sm leading-snug transition-colors hover:border-accent/50 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
            <span>{text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
