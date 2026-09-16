// CoinMarketCap REST client for the Real World Assets (/v5) endpoints.
// Every call is recorded so the UI can show the exact evidence behind a report.

import { readFileSync } from "node:fs";

const BASE = "https://pro-api.coinmarketcap.com";
// 1008/1010 are the minute and daily rate limits. CMC sends them with HTTP 200,
// so error codes have to be checked separately from status codes.
const RETRY_ERROR_CODES = new Set(["1008", "1010"]);
const RETRY_HTTP = new Set([429, 500, 502, 503, 504]);

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
      const ok = response.ok && (errorCode === "0" || errorCode === "undefined");
      const retryable =
        RETRY_HTTP.has(response.status) || RETRY_ERROR_CODES.has(errorCode);

      if (!ok && retryable && attempt < tries) {
        await sleep(delay);
        delay *= 2;
        continue;
      }

      evidence.push({
        endpoint,
        url: redactKey(url.toString()),
        params,
        http_status: response.status,
        error_code: errorCode,
        error_message: status.error_message ?? null,
        credit_count: status.credit_count ?? null,
        elapsed_ms: Date.now() - startedAt,
        cmc_timestamp: status.timestamp ?? null,
        received_at: new Date().toISOString(),
        response: body,
      });

      if (!ok) {
        const message =
          status.error_message || `HTTP ${response.status} from ${endpoint}`;
        throw new CmcError(message, { code: errorCode, endpoint });
      }
      return body;
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
