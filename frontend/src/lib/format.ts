/** Small presentation helpers. */

/** Only http(s) URLs are ever rendered as links. */
export function safeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export function displayDomain(value: string): string {
  const url = safeHttpUrl(value);
  return url ? url.hostname.replace(/^www\./, "") : value;
}

export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const minutes = Math.round((now - timestamp) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}
