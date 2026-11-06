/**
 * In-memory limiter for failed access-code attempts (server-only).
 *
 * Two budgets per window: one per client (IP when the platform provides one) and one global,
 * which blunts guessing spread across many IPs. The state lives in this server process: in
 * Docker or on a single Node server it is exact; on Vercel each function instance keeps its
 * own counters, so it is best effort there. Codes are required to be long and random, which
 * is what actually makes online guessing infeasible (see docs/DEPLOYMENT.md).
 */

export interface LimiterOptions {
  maxFailuresPerClient: number;
  maxFailuresGlobal: number;
  windowMs: number;
  maxClients: number;
  now?: () => number;
}

interface Bucket {
  failures: number;
  windowStart: number;
}

export class LoginLimiter {
  private readonly clients = new Map<string, Bucket>();
  private global: Bucket = { failures: 0, windowStart: 0 };
  private readonly now: () => number;

  constructor(private readonly options: LimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Seconds until `key` may try again, or 0 when an attempt is allowed. */
  retryAfterSeconds(key: string): number {
    const now = this.now();
    const until = (bucket: Bucket | undefined, max: number) =>
      bucket && this.active(bucket, now) && bucket.failures >= max ? bucket.windowStart + this.options.windowMs - now : 0;
    const wait = Math.max(
      until(this.clients.get(key), this.options.maxFailuresPerClient),
      until(this.global, this.options.maxFailuresGlobal),
    );
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  recordFailure(key: string): void {
    const now = this.now();
    this.global = this.bump(this.global, now);
    const bucket = this.clients.get(key);
    this.clients.delete(key); // re-insert so Map order tracks recency
    this.clients.set(key, this.bump(bucket, now));
    while (this.clients.size > this.options.maxClients) {
      const oldest = this.clients.keys().next().value;
      if (oldest === undefined) break;
      this.clients.delete(oldest);
    }
  }

  recordSuccess(key: string): void {
    this.clients.delete(key);
  }

  private active(bucket: Bucket, now: number): boolean {
    return now - bucket.windowStart < this.options.windowMs;
  }

  private bump(bucket: Bucket | undefined, now: number): Bucket {
    if (!bucket || !this.active(bucket, now)) return { failures: 1, windowStart: now };
    return { failures: bucket.failures + 1, windowStart: bucket.windowStart };
  }
}

export const loginLimiter = new LoginLimiter({
  maxFailuresPerClient: 5,
  maxFailuresGlobal: 50,
  windowMs: 15 * 60 * 1000,
  maxClients: 10_000,
});
