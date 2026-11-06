import { KeyRound, Lock, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { BrandMark } from "@/components/BrandMark";
import { ACCESS_COOKIE, safeNextPath, verifySessionToken } from "@/server/access";
import { getGateConfig } from "@/server/config";

export const metadata: Metadata = {
  title: "Access · Search + Weather Assistant",
  robots: { index: false, follow: false },
};

const MESSAGES: Record<string, string> = {
  invalid: "That access code isn't valid. Check it and try again.",
  locked: "Too many incorrect attempts. Wait 15 minutes, then try again.",
  unavailable: "Access to this demo isn't configured yet. Contact the owner.",
  origin: "The request came from another site and was blocked. Open this page directly and try again.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function AccessPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  const config = getGateConfig();

  if (config.mode === "disabled") redirect(next);
  if (config.mode === "enabled" && verifySessionToken(config, (await cookies()).get(ACCESS_COOKIE)?.value)) {
    redirect(next);
  }

  const error = config.mode === "misconfigured" ? "unavailable" : first(params.error);
  const message = error ? (MESSAGES[error] ?? MESSAGES.invalid) : null;
  const signedOut = first(params.signed_out) === "1" && !message;

  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <BrandMark className="size-8" />
          <span className="font-display text-lg font-semibold tracking-tight">Search + Weather</span>
        </div>

        <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
          <div className="mb-4 grid size-10 place-items-center rounded-xl bg-surface-2 text-accent">
            <Lock className="size-5" aria-hidden="true" />
          </div>
          <h1 className="font-display text-xl font-semibold tracking-tight">Private demo</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            This assistant is shared by invitation. Enter the access code you were given to continue.
          </p>

          {message && (
            <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-ink">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
              {message}
            </p>
          )}
          {signedOut && (
            <p role="status" className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
              You&apos;ve signed out on this browser.
            </p>
          )}

          {config.mode === "enabled" && (
            <form method="post" action="/api/access" className="mt-5 space-y-3">
              <input type="hidden" name="next" value={next} />
              <label htmlFor="code" className="block text-sm font-medium">
                Access code
              </label>
              <div className="relative">
                <KeyRound
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                  aria-hidden="true"
                />
                <input
                  id="code"
                  name="code"
                  type="password"
                  required
                  autoFocus
                  autoComplete="current-password"
                  spellCheck={false}
                  maxLength={256}
                  className="focus-ring w-full rounded-lg border border-line bg-bg py-2.5 pr-3 pl-9 text-sm"
                />
              </div>
              <button
                type="submit"
                className="focus-ring w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90"
              >
                Continue
              </button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-xs leading-relaxed text-muted">
          Access is kept in a secure cookie on this browser. Codes can be revoked by the owner at any time.
        </p>
      </div>
    </main>
  );
}
