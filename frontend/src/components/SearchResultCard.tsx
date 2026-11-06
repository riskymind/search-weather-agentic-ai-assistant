import { ExternalLink, Globe } from "lucide-react";

import { displayDomain, safeHttpUrl } from "@/lib/format";
import type { SearchResult } from "@/types/agent";

export function SearchResultCard({ result }: { result: SearchResult }) {
  const url = safeHttpUrl(result.url);
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Globe className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{displayDomain(result.url)}</span>
        {url && (
          <ExternalLink
            className="ml-auto size-3.5 shrink-0 opacity-60 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        )}
      </span>
      <span className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug">{result.title}</span>
      {result.content && <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{result.content}</span>}
    </>
  );

  const className = "group flex h-full flex-col rounded-xl border border-line bg-surface p-3.5";

  // Only http(s) URLs become links; they open in a new tab without access to this page.
  if (!url) return <div className={className}>{body}</div>;
  return (
    <a
      href={url.href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} focus-ring transition-colors hover:border-accent/60 hover:bg-surface-2`}
    >
      {body}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
