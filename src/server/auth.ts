/**
 * API Key Authentication Middleware
 *
 * Protects the proxy endpoints with a Bearer token (OpenAI style).
 * Configure via PROXY_API_KEY environment variable.
 *
 * Behavior:
 * - If PROXY_API_KEY is not set, a secure random key is generated at
 *   startup and printed to the logs (auth stays ON).
 * - Set PROXY_API_KEY=off to explicitly disable authentication
 *   (only recommended for local development).
 * - /health is always public so uptime checks keep working.
 */

import type { Request, Response, NextFunction } from "express";
import { randomBytes, timingSafeEqual } from "crypto";

let configuredKey: string | null = null;
let authEnabled = false;

/**
 * Initialize the API key from the environment.
 * Returns a status object so the caller can log what happened.
 */
export function initApiKey(): {
  enabled: boolean;
  generated: boolean;
  key: string | null;
} {
  const raw = process.env.PROXY_API_KEY?.trim();

  if (raw && raw.toLowerCase() === "off") {
    configuredKey = null;
    authEnabled = false;
    return { enabled: false, generated: false, key: null };
  }

  if (raw) {
    configuredKey = raw;
    authEnabled = true;
    return { enabled: true, generated: false, key: raw };
  }

  // No key configured: generate one instead of running unprotected
  const generated = `sk-proxy-${randomBytes(24).toString("hex")}`;
  configuredKey = generated;
  authEnabled = true;
  return { enabled: true, generated: true, key: generated };
}

export function isAuthEnabled(): boolean {
  return authEnabled;
}

let configuredAdminKey: string | null = null;

/**
 * Initialize the optional admin key (PROXY_ADMIN_KEY).
 * Falls back to the regular API key when no dedicated admin key is set.
 * Returns the same shape as initApiKey for startup logging.
 */
export function initAdminKey(): { configured: boolean; fallback: boolean } {
  const raw = process.env.PROXY_ADMIN_KEY?.trim();
  if (raw) {
    configuredAdminKey = raw;
    return { configured: true, fallback: false };
  }
  return { configured: false, fallback: true };
}

/**
 * Express middleware for /admin/* routes.
 * Requires PROXY_ADMIN_KEY; if unset, the regular PROXY_API_KEY is accepted.
 * If neither exists, admin routes are locked (403).
 */
export function adminAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const effective = configuredAdminKey || configuredKey;

  if (!effective) {
    res.status(403).json({
      error: {
        message:
          "Admin endpoints are locked. Set PROXY_ADMIN_KEY (or PROXY_API_KEY) to enable them.",
        type: "invalid_request_error",
        code: "admin_locked",
      },
    });
    return;
  }

  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (!token || !safeEqual(token, effective)) {
    res.status(401).json({
      error: {
        message: "Invalid admin key.",
        type: "invalid_request_error",
        code: "invalid_admin_key",
      },
    });
    return;
  }

  next();
}

/**
 * Constant-time string comparison to avoid timing attacks.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware enforcing the API key on all routes except /health.
 */
export function apiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!authEnabled || !configuredKey) {
    next();
    return;
  }

  // Health check stays public (uptime monitors, EasyPanel checks)
  // Admin routes handle their own (stricter) auth via adminAuth
  if (req.path === "/health" || req.path.startsWith("/admin")) {
    next();
    return;
  }

  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (!token || !safeEqual(token, configuredKey)) {
    res.status(401).json({
      error: {
        message:
          "Invalid or missing API key. Provide it as 'Authorization: Bearer <key>'.",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    return;
  }

  next();
}
