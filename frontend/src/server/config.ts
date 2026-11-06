/**
 * Server-only configuration for the API proxy and the access gate.
 *
 * Nothing here may be imported by client components: these variables are read from the
 * server's runtime environment (never `NEXT_PUBLIC_*`) and are never sent to the browser.
 * Values are read on each call, so tests and redeploys with new variables need no rebuild.
 */

const DEV_BACKEND_URL = "http://localhost:8000";
const LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MIN_ACCESS_CODE_LENGTH = 16;
export const MIN_SESSION_SECRET_LENGTH = 32;
const DEFAULT_SESSION_TTL_HOURS = 168;

export interface BackendConfig {
  /** FastAPI base URL as reached from this server (e.g. http://backend:8000 in Compose). */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <key>`; must equal the backend's API_ACCESS_KEY. */
  accessKey: string | null;
}

export interface AccessCode {
  label: string;
  code: string;
}

export type GateConfig =
  | { mode: "disabled" }
  | { mode: "enabled"; codes: AccessCode[]; secret: string; ttlSeconds: number }
  | { mode: "misconfigured"; problems: string[] };

const env = (name: string): string => (process.env[name] ?? "").trim();
const isProduction = () => process.env.NODE_ENV === "production";

export class ConfigError extends Error {}

export function getBackendConfig(): BackendConfig {
  const raw = env("BACKEND_API_URL") || (isProduction() ? "" : DEV_BACKEND_URL);
  if (!raw) throw new ConfigError("BACKEND_API_URL is not set");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("BACKEND_API_URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("BACKEND_API_URL must be an http(s) URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("BACKEND_API_URL must not contain credentials, a query or a fragment");
  }
  return {
    baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ""),
    accessKey: env("BACKEND_API_ACCESS_KEY") || null,
  };
}

/**
 * ACCESS_CODES is a comma-separated list of `label:code` pairs, one per person or audience
 * (e.g. `reviewer-a:Xk3...,reviewer-b:9fQ...`). Removing a pair revokes that code and every
 * session created with it; rotating ACCESS_SESSION_SECRET revokes all sessions.
 */
export function parseAccessCodes(raw: string): { codes: AccessCode[]; problems: string[] } {
  const codes: AccessCode[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, index) => {
      const separator = entry.indexOf(":");
      const label = separator === -1 ? "" : entry.slice(0, separator).trim().toLowerCase();
      const code = separator === -1 ? "" : entry.slice(separator + 1).trim();
      const where = `ACCESS_CODES entry ${index + 1}`;
      if (!LABEL_PATTERN.test(label)) {
        problems.push(`${where}: expected "label:code" with a label of a-z, 0-9, "-" or "_" (max 32)`);
      } else if (seen.has(label)) {
        problems.push(`${where}: duplicate label "${label}"`);
      } else if (code.length < MIN_ACCESS_CODE_LENGTH) {
        problems.push(`${where} ("${label}"): the code must be at least ${MIN_ACCESS_CODE_LENGTH} characters`);
      } else {
        seen.add(label);
        codes.push({ label, code });
      }
    });
  return { codes, problems };
}

/**
 * Gate modes:
 * - `enabled` when ACCESS_CODES is set (ACCESS_SESSION_SECRET is then required);
 * - `disabled` when ACCESS_CODES is empty and either this is not a production build or
 *   ALLOW_PUBLIC_ACCESS=true explicitly accepts a public deployment;
 * - otherwise `misconfigured`, which fails closed: every protected route is refused.
 */
export function getGateConfig(): GateConfig {
  const rawCodes = env("ACCESS_CODES");
  if (!rawCodes) {
    if (!isProduction() || env("ALLOW_PUBLIC_ACCESS").toLowerCase() === "true") return { mode: "disabled" };
    return {
      mode: "misconfigured",
      problems: ["ACCESS_CODES is not set (or set ALLOW_PUBLIC_ACCESS=true to run without an access gate)"],
    };
  }

  const { codes, problems } = parseAccessCodes(rawCodes);
  const secret = env("ACCESS_SESSION_SECRET");
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(`ACCESS_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  }
  const ttlRaw = env("ACCESS_SESSION_TTL_HOURS");
  const ttlHours = ttlRaw ? Number(ttlRaw) : DEFAULT_SESSION_TTL_HOURS;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 90) {
    problems.push("ACCESS_SESSION_TTL_HOURS must be a number of hours between 0 and 2160");
  }
  if (codes.length === 0 && problems.length === 0) problems.push("ACCESS_CODES contains no valid entries");
  if (problems.length > 0) return { mode: "misconfigured", problems };
  return { mode: "enabled", codes, secret, ttlSeconds: Math.round(ttlHours * 3600) };
}
