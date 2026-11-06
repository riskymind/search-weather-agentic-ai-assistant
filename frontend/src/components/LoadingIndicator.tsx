export function LoadingIndicator({ label = "Working on it" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-[pulse-dot_1.2s_ease-in-out_infinite] rounded-full bg-accent"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
      <span>{label}</span>
    </div>
  );
}
