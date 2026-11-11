import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, getSessionUserByToken } from "@/lib/server/local/auth";

/**
 * The private instance's front door (Next 16's `proxy`, formerly middleware;
 * it runs on the Node runtime, so it can read the session database).
 * Everything needs a signed-in session except the sign-in surface and the
 * static assets a signed-out page needs. State-changing requests must come
 * from this site (Origin or Referer host equals Host), the CSRF check on top
 * of the SameSite=Strict cookie.
 */

const PUBLIC_EXACT = new Set([
  "/login",
  "/api/community/auth/login",
  "/api/community/auth/register",
  "/api/community/auth/me",
  "/manifest.webmanifest",
  "/site-icon.png",
]);
const PUBLIC_PREFIXES = ["/_next/static/", "/favicon", "/icon", "/apple-touch-icon"];

// No 'unsafe-eval': the HiGHS glue loads via importScripts in the solve worker (lp-engine.ts).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function readSessionCookie(request: NextRequest): string | undefined {
  const value = request.cookies.get(SESSION_COOKIE)?.value;
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

function isSameOrigin(request: NextRequest): boolean {
  const host = request.headers.get("host");
  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!host || !source) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

function isPageRequest(request: NextRequest, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (pathname.startsWith("/api/") || pathname.startsWith("/datasets/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  return !/\.[A-Za-z0-9]+$/.test(pathname);
}

function withSecurityHeaders(response: Response): Response {
  response.headers.set("Content-Security-Policy", CSP);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

function deny(status: number, error: string): Response {
  return withSecurityHeaders(
    NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } }),
  );
}

/** GTNH_ALLOWED_HOSTS=host[:port],... refuses any other Host (DNS-rebinding guard). Unset = any. */
const ALLOWED_HOSTS = (process.env.GTNH_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

export function proxy(request: NextRequest): Response {
  const { pathname, search } = request.nextUrl;

  if (ALLOWED_HOSTS.length > 0 && !ALLOWED_HOSTS.includes((request.headers.get("host") ?? "").toLowerCase())) {
    return deny(421, "Unknown host.");
  }

  if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request)) {
    return deny(403, "Cross-site request refused.");
  }

  if (!isPublicPath(pathname)) {
    const token = readSessionCookie(request);
    const user = token ? getSessionUserByToken(token) : undefined;
    if (!user) {
      if (isPageRequest(request, pathname)) {
        // Only a same-origin relative path may ride along as `next`.
        const target = `${pathname}${search}`;
        const safe = target.startsWith("/") && !target.startsWith("//") && !target.includes("\\");
        const location = safe ? `/login?next=${encodeURIComponent(target)}` : "/login";
        // The Host header names the site the browser used; behind a TLS proxy the
        // scheme comes from X-Forwarded-Proto.
        const proto =
          request.headers.get("x-forwarded-proto") === "https" ? "https:" : request.nextUrl.protocol;
        const origin = `${proto}//${request.headers.get("host") ?? request.nextUrl.host}`;
        return withSecurityHeaders(
          NextResponse.redirect(new URL(location, origin), {
            status: 307,
            headers: { "Cache-Control": "no-store" },
          }),
        );
      }
      return deny(401, "Sign in required.");
    }
  }

  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: ["/((?!_next/static).*)"],
};
