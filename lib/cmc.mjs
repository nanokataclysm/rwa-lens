// CoinMarketCap REST client for the Real World Assets (/v5) endpoints.
// Every call is recorded so the UI can show the exact evidence behind a report.

import { readFileSync } from "node:fs";

const BASE = "https://pro-api.coinmarketcap.com";
// Plan limits do not clear inside a retry loop, so they fail immediately with
// the wait that would actually help. The per-minute window needs a full 60
// seconds; backing off in milliseconds just burns the remaining attempts.
const PLAN_LIMITS = {
  1008: "Per-minute rate limit reached. The window resets 60 seconds after the first call in it — wait a minute, then retry.",
  1009: "Daily rate limit reached. It resets at 00:00 UTC.",
  1010: "Monthly credit limit reached. It resets on the plan's renewal date.",
};

// Problems with the key or the plan; retrying changes nothing.
const FATAL = {
  1001: "API key rejected. Check CMC_API_KEY in .env.",
  1002: "This call needs an API key and none was sent.",
  1006: "This API key's plan does not include the endpoint. The RWA endpoints need Basic or higher.",
  1007: "This API key has been disabled.",
};

// 1011 is an IP-level limit from too many concurrent calls: short-lived, so
// backing off does clear it.
const RETRY_ERROR_CODES = new Set(["1011"]);
const RETRY_HTTP = new Set([500, 502, 503, 504]);

export class CmcError extends Error {
  constructor(message, { code, endpoint } = {}) {
    super(message);
    this.name = "CmcError";
    this.code = code;
    this.endpoint = endpoint;
  }
}

export function loadApiKey(envPath = ".env") {
  if (process.env.CMC_API_KEY) return process.env.CMC_API_KEY.trim();
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = line.match(/^\s*CMC_API_KEY\s*=\s*(.+?)\s*$/);
      if (match) return match[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env file; fall through
  }
  return null;
}

export function createClient({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new CmcError(
      "No CoinMarketCap API key. Set CMC_API_KEY or put it in .env " +
        "(the free Basic plan covers every RWA endpoint).",
      { code: "NO_KEY" },
    );
  }

  const evidence = [];

  async function call(endpoint, params = {}, { tries = 4 } = {}) {
    const url = new URL(BASE + endpoint);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let delay = 1500;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      const startedAt = Date.now();
      let response;
      let body;
      try {
        response = await fetchImpl(url, {
          headers: { Accept: "application/json", "X-CMC_PRO_API_KEY": apiKey },
          signal: AbortSignal.timeout(20_000),
        });
        body = await response.json();
      } catch (err) {
        if (attempt < tries) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        throw new CmcError(`Network error calling ${endpoint}: ${err.message}`, {
          code: "NETWORK",
          endpoint,
        });
      }

      const status = body?.status ?? {};
      const errorCode = String(status.error_code ?? "0");
      const ok = response.ok && errorCode === "0";

      // Every attempt is recorded, so a report shows the retries it needed.
      evidence.push({
        endpoint,
        url: redactKey(url.toString()),
        params,
        attempt,
        http_status: response.status,
        error_code: errorCode,
        error_message: status.error_message ?? null,
        credit_count: status.credit_count ?? null,
        elapsed_ms: Date.now() - startedAt,
        cmc_timestamp: status.timestamp ?? null,
        received_at: new Date().toISOString(),
        response: body,
      });

      if (ok) return body;

      if (PLAN_LIMITS[errorCode]) {
        throw new CmcError(PLAN_LIMITS[errorCode], { code: errorCode, endpoint });
      }
      if (FATAL[errorCode]) {
        throw new CmcError(FATAL[errorCode], { code: errorCode, endpoint });
      }

      const retryable =
        RETRY_HTTP.has(response.status) || RETRY_ERROR_CODES.has(errorCode);
      if (retryable && attempt < tries) {
        await sleep(delay);
        delay *= 2;
        continue;
      }

      throw new CmcError(
        status.error_message || `HTTP ${response.status} from ${endpoint}`,
        { code: errorCode, endpoint },
      );
    }
    throw new CmcError(`Gave up on ${endpoint} after ${tries} attempts`, {
      code: "RETRY_EXHAUSTED",
      endpoint,
    });
  }

  return {
    evidence,
    creditsUsed: () =>
      evidence.reduce((total, item) => total + (Number(item.credit_count) || 0), 0),

    // Resolve a ticker to the stable rwa_id. Costs no credits.
    map: (params) => call("/v5/real-world-assets/map", params),
    // Static metadata: company fields plus the About block.
    info: (params) => call("/v5/real-world-assets/info", params),
    // Market data: aggregate tokenized values, per-token prices, trading venues.
    quotes: (params) => call("/v5/real-world-assets/quotes/latest", params),
    // Paginated asset list with tokenized aggregates.
    assets: (params) => call("/v5/real-world-assets/assets/list", params),
    // Every tracked market for one asset's tokens.
    marketPairs: (params) =>
      call("/v5/real-world-assets/market-pairs/list", params),
    // One issuer with its linked tokens.
    issuer: (params) => call("/v5/real-world-assets/issuers", params),
    issuers: (params) => call("/v5/real-world-assets/issuers/list", params),
  };
}

function redactKey(url) {
  return url.replace(/([?&]CMC_PRO_API_KEY=)[^&]+/i, "$1REDACTED");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
