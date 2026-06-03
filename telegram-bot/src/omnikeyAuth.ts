import axios from "axios";
import type { Logger } from "winston";
import { omnikeyBaseUrl } from "./config";

interface ActivateResponse {
  token: string;
  subscriptionStatus: string;
  expiresAt: string | null;
}

interface JwtPayload {
  exp?: number;
}

let cachedToken: string | null = null;
let cachedExpiresAtMs: number | null = null;

// Renew JWTs a few minutes before expiry to avoid mid-WebSocket failures.
const RENEW_BEFORE_MS = 60 * 1000;

function decodeJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(
        parts[1].replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as JwtPayload;
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function fetchJwtToken(
  logger: Logger,
  force = false,
): Promise<string> {
  const now = Date.now();
  if (
    !force &&
    cachedToken &&
    cachedExpiresAtMs &&
    cachedExpiresAtMs - RENEW_BEFORE_MS > now
  ) {
    return cachedToken;
  }

  const url = `${omnikeyBaseUrl()}/api/subscription/activate`;
  logger.info("Requesting JWT from omnikey-ai", { url });

  const resp = await axios.post<ActivateResponse>(url, {}, { timeout: 10_000 });
  if (!resp.data?.token) {
    throw new Error("activate endpoint returned no token");
  }

  cachedToken = resp.data.token;
  cachedExpiresAtMs = decodeJwtExpiry(cachedToken);
  logger.info("Received JWT from omnikey-ai", {
    subscriptionStatus: resp.data.subscriptionStatus,
    expiresAt: cachedExpiresAtMs
      ? new Date(cachedExpiresAtMs).toISOString()
      : null,
  });
  return cachedToken;
}

export function clearCachedToken(): void {
  cachedToken = null;
  cachedExpiresAtMs = null;
}
