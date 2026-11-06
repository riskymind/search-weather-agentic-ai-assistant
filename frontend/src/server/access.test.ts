// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as login } from "@/app/api/access/route";
import { POST as logout } from "@/app/api/access/logout/route";
import { proxy } from "@/proxy";
import {
  createSessionToken,
  matchAccessCode,
  readCookie,
  safeNextPath,
  verifySessionToken,
} from "@/server/access";
import { getBackendConfig, getGateConfig, parseAccessCodes, type GateConfig } from "@/server/config";
import { LoginLimiter } from "@/server/loginLimiter";
import { ORIGIN, REVIEWER_CODE, sessionCookieHeader, stubServerEnv } from "@/test/server";

type Enabled = Extract<GateConfig, { mode: "enabled" }>;

beforeEach(() => stubServerEnv());
afterEach(() => vi.unstubAllEnvs());

const enabledConfig = (): Enabled => {
  const config = getGateConfig();
  if (config.mode !== "enabled") throw new Error(`expected enabled gate, got ${config.mode}`);
  return config;
};

describe("gate configuration", () => {
  it("parses labelled codes", () => {
    const { codes, problems } = parseAccessCodes(" Reviewer-A : aaaaaaaaaaaaaaaa , b:bbbbbbbbbbbbbbbb:with-colon ");
    expect(problems).toEqual([]);
    expect(codes).toEqual([
      { label: "reviewer-a", code: "aaaaaaaaaaaaaaaa" },
      { label: "b", code: "bbbbbbbbbbbbbbbb:with-colon" },
    ]);
  });

  it("reports weak, unlabelled and duplicate codes without echoing them", () => {
    const { problems } = parseAccessCodes("short:abc,nolabelcodexxxxxxxxx,a:aaaaaaaaaaaaaaaa,a:cccccccccccccccc");
    expect(problems).toHaveLength(3);
    expect(problems.join(" ")).not.toContain("abc");
    expect(problems.join(" ")).not.toContain("cccccccccccccccc");
  });

  it("is enabled when codes are configured", () => {
    expect(enabledConfig().ttlSeconds).toBe(168 * 3600);
  });

  it("is disabled in development without codes", () => {
    stubServerEnv({ NODE_ENV: "development", ACCESS_CODES: "" });
    expect(getGateConfig().mode).toBe("disabled");
  });

  it("fails closed in production without codes, unless public access is explicitly allowed", () => {
    stubServerEnv({ ACCESS_CODES: "" });
    expect(getGateConfig().mode).toBe("misconfigured");
    stubServerEnv({ ACCESS_CODES: "", ALLOW_PUBLIC_ACCESS: "true" });
    expect(getGateConfig().mode).toBe("disabled");
  });

  it("requires a strong session secret", () => {
    stubServerEnv({ ACCESS_SESSION_SECRET: "short" });
    const config = getGateConfig();
    expect(config.mode).toBe("misconfigured");
    expect(config.mode === "misconfigured" && config.problems.join()).toContain("ACCESS_SESSION_SECRET");
  });

  it("validates the backend URL", () => {
    expect(getBackendConfig()).toEqual({ baseUrl: "http://backend.internal:8000", accessKey: "k".repeat(48) });
    stubServerEnv({ BACKEND_API_URL: "https://user:pass@api.example.com" });
    expect(() => getBackendConfig()).toThrow(/credentials/);
    stubServerEnv({ BACKEND_API_URL: "ftp://api.example.com" });
    expect(() => getBackendConfig()).toThrow(/http/);
    stubServerEnv({ NODE_ENV: "development", BACKEND_API_URL: "" });
    expect(getBackendConfig().baseUrl).toBe("http://localhost:8000");
  });
});

describe("session tokens", () => {
  it("round-trips and never contains the code or secret", () => {
    const config = enabledConfig();
    const token = createSessionToken(config, "reviewer");
    expect(verifySessionToken(config, token)).toBe("reviewer");
    expect(token).not.toContain(REVIEWER_CODE);
    expect(token).not.toContain(config.secret);
  });

  it("rejects expired, tampered and malformed tokens", () => {
    const config = enabledConfig();
    const now = Date.now();
    const token = createSessionToken(config, "reviewer", now);
    expect(verifySessionToken(config, token, now + config.ttlSeconds * 1000 + 1000)).toBeNull();
    const [v, , exp, sig] = token.split(".");
    expect(verifySessionToken(config, `${v}.owner.${exp}.${sig}`)).toBeNull();
    expect(verifySessionToken(config, `${v}.reviewer.${Number(exp) + 1000}.${sig}`)).toBeNull();
    expect(verifySessionToken(config, `${token}x`)).toBeNull();
    for (const bad of [undefined, "", "v1", "v2.reviewer.1.x", "v1.reviewer.abc.x"]) {
      expect(verifySessionToken(config, bad)).toBeNull();
    }
  });

  it("is revoked when its code is removed or changed, or the secret is rotated", () => {
    const token = createSessionToken(enabledConfig(), "reviewer");
    stubServerEnv({ ACCESS_CODES: "owner:owner-code-abcdefghijklmnop" });
    expect(verifySessionToken(enabledConfig(), token)).toBeNull();
    stubServerEnv({ ACCESS_CODES: "reviewer:a-brand-new-code-0987654321" });
    expect(verifySessionToken(enabledConfig(), token)).toBeNull();
    stubServerEnv({ ACCESS_SESSION_SECRET: "t".repeat(40) });
    expect(verifySessionToken(enabledConfig(), token)).toBeNull();
    stubServerEnv();
    expect(verifySessionToken(enabledConfig(), token)).toBe("reviewer");
  });

  it("matches codes exactly", () => {
    const { codes } = enabledConfig();
    expect(matchAccessCode(REVIEWER_CODE, codes)).toBe("reviewer");
    expect(matchAccessCode(`${REVIEWER_CODE} `, codes)).toBeNull();
    expect(matchAccessCode(REVIEWER_CODE.toUpperCase(), codes)).toBeNull();
    expect(matchAccessCode("", codes)).toBeNull();
  });
});

describe("helpers", () => {
  it("only allows same-site relative redirect targets", () => {
    expect(safeNextPath("/?x=1")).toBe("/?x=1");
    for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "/access", "/api/agent/query"]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });

  it("reads a cookie by exact name", () => {
    const request = new Request(ORIGIN, { headers: { cookie: "a=1; sw_access_x=2; sw_access=v1.a.1.b=c" } });
    expect(readCookie(request, "sw_access")).toBe("v1.a.1.b=c");
    expect(readCookie(request, "missing")).toBeUndefined();
  });
});

describe("LoginLimiter", () => {
  it("locks a client out after repeated failures until the window passes", () => {
    let now = 0;
    const limiter = new LoginLimiter({ maxFailuresPerClient: 3, maxFailuresGlobal: 100, windowMs: 1000, maxClients: 10, now: () => now });
    for (let i = 0; i < 3; i++) limiter.recordFailure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(1);
    expect(limiter.retryAfterSeconds("b")).toBe(0);
    now = 1000;
    expect(limiter.retryAfterSeconds("a")).toBe(0);
  });

  it("applies a global budget across clients", () => {
    const limiter = new LoginLimiter({ maxFailuresPerClient: 100, maxFailuresGlobal: 3, windowMs: 60_000, maxClients: 10 });
    ["a", "b", "c"].forEach((key) => limiter.recordFailure(key));
    expect(limiter.retryAfterSeconds("fresh")).toBeGreaterThan(0);
  });

  it("resets a client on success and bounds memory", () => {
    const limiter = new LoginLimiter({ maxFailuresPerClient: 1, maxFailuresGlobal: 100, windowMs: 60_000, maxClients: 2 });
    limiter.recordFailure("a");
    limiter.recordSuccess("a");
    expect(limiter.retryAfterSeconds("a")).toBe(0);
    ["x", "y", "z"].forEach((key) => limiter.recordFailure(key));
    expect(limiter.retryAfterSeconds("x")).toBe(0); // evicted as the oldest
    expect(limiter.retryAfterSeconds("z")).toBeGreaterThan(0);
  });
});

let ipCounter = 0;

/** A login form POST from a unique client IP (so the shared limiter does not leak between tests). */
function loginRequest(code: string, { next, ip, origin = ORIGIN, url = `${ORIGIN}/api/access` } = {} as {
  next?: string;
  ip?: string;
  origin?: string;
  url?: string;
}) {
  const body = new URLSearchParams({ code, ...(next ? { next } : {}) }).toString();
  return new Request(url, {
    method: "POST",
    body,
    headers: {
      host: new URL(url).host,
      origin,
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": ip ?? `198.51.100.${++ipCounter}`,
    },
  });
}

describe("POST /api/access", () => {
  beforeEach(() => {
    stubServerEnv({ VERCEL: "1" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("sets a secure HttpOnly session cookie and redirects to the requested page", async () => {
    const response = await login(loginRequest(REVIEWER_CODE, { next: "/?q=1", url: "https://app.test/api/access", origin: "https://app.test" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?q=1");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^sw_access=v1\.reviewer\.\d+\.[\w-]+; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure$/);
    expect(cookie).not.toContain(REVIEWER_CODE);
  });

  it("omits Secure on plain-HTTP local servers", async () => {
    const cookie = (await login(loginRequest(REVIEWER_CODE))).headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
  });

  it("rejects a wrong code without setting a cookie", async () => {
    const response = await login(loginRequest("wrong-code-wrong-code", { next: "/x" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/access?error=invalid&next=%2Fx");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("locks out a client after 5 failures, even for the correct code", async () => {
    const ip = "203.0.113.200";
    for (let i = 0; i < 5; i++) await login(loginRequest(`wrong-${i}-xxxxxxxxxxxxxxxx`, { ip }));
    const locked = await login(loginRequest(REVIEWER_CODE, { ip }));
    expect(locked.headers.get("location")).toContain("error=locked");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(locked.headers.get("set-cookie")).toBeNull();
    // Other clients are unaffected.
    expect((await login(loginRequest(REVIEWER_CODE))).headers.get("set-cookie")).toContain("sw_access=");
  });

  it("refuses cross-site posts and open redirects", async () => {
    const cross = await login(loginRequest(REVIEWER_CODE, { origin: "https://evil.example" }));
    expect(cross.headers.get("location")).toContain("error=origin");
    expect(cross.headers.get("set-cookie")).toBeNull();
    const open = await login(loginRequest(REVIEWER_CODE, { next: "//evil.example" }));
    expect(open.headers.get("location")).toBe("/");
  });

  it("does nothing useful when the gate is misconfigured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubServerEnv({ ACCESS_SESSION_SECRET: "" });
    const response = await login(loginRequest(REVIEWER_CODE));
    expect(response.headers.get("location")).toContain("error=unavailable");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/access/logout", () => {
  it("clears the cookie", () => {
    const response = logout(new Request(`${ORIGIN}/api/access/logout`, { method: "POST", headers: { host: "app.test", origin: ORIGIN } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("sw_access=; Path=/; Max-Age=0; HttpOnly");
  });

  it("rejects cross-site logout", () => {
    const response = logout(
      new Request(`${ORIGIN}/api/access/logout`, { method: "POST", headers: { host: "app.test", origin: "https://evil.example" } }),
    );
    expect(response.status).toBe(403);
  });
});

describe("proxy (gate for pages and API routes)", () => {
  const visit = (path: string, cookie?: string) =>
    proxy(new NextRequest(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} }));

  it("redirects anonymous page visits to /access, keeping the destination", () => {
    const home = visit("/");
    expect(home.status).toBe(307);
    expect(home.headers.get("location")).toBe(`${ORIGIN}/access`);
    expect(visit("/some/page?x=1").headers.get("location")).toBe(`${ORIGIN}/access?next=%2Fsome%2Fpage%3Fx%3D1`);
  });

  it("answers anonymous API calls with a 401 envelope", async () => {
    const response = visit("/api/agent/stream");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "access_required", message: "Enter an access code to use this demo." },
    });
  });

  it("lets signed-in visitors and the access routes through", () => {
    expect(visit("/", sessionCookieHeader()).headers.get("x-middleware-next")).toBe("1");
    expect(visit("/api/health", sessionCookieHeader()).headers.get("x-middleware-next")).toBe("1");
    expect(visit("/access").headers.get("x-middleware-next")).toBe("1");
    expect(visit("/api/access").headers.get("x-middleware-next")).toBe("1");
    expect(visit("/api/access/logout").headers.get("x-middleware-next")).toBe("1");
  });

  it("does not treat look-alike paths as public", () => {
    expect(visit("/accessories").status).toBe(307);
    expect(visit("/api/accessibility").status).toBe(401);
  });

  it("returns 503 for API calls when the gate is misconfigured", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubServerEnv({ ACCESS_CODES: "" });
    expect(visit("/api/agent/query").status).toBe(503);
    expect(visit("/").status).toBe(307);
  });

  it("is open when the gate is disabled", () => {
    stubServerEnv({ ACCESS_CODES: "", ALLOW_PUBLIC_ACCESS: "true" });
    expect(visit("/api/agent/query").headers.get("x-middleware-next")).toBe("1");
  });
});
