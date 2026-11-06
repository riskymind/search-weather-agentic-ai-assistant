/** Logo: a sun inside sweeping isobars. Decorative; the product name is always shown beside it. */
export function BrandMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" className="fill-accent" />
      <path
        d="M4 21c5-5 10-6 15-3s7 2 9-1M4 26c6-4 11-4 16-1.5S27 26 29 24"
        fill="none"
        strokeWidth="1.6"
        strokeLinecap="round"
        className="stroke-accent-ink opacity-70"
      />
      <circle cx="19" cy="11" r="4.2" className="fill-sun" />
    </svg>
  );
}
