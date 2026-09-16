// RWA investigation service: query -> rwa_id -> metadata -> quote -> issuers ->
// token representations -> deterministic parity -> structured result.

import { CmcError } from "./cmc.mjs";
import { computeParity, freshness } from "./parity.mjs";

// Each extra issuer lookup costs a credit, so cap it on the free plan.
const MAX_ISSUER_LOOKUPS = 5;

const first = (body) => body?.data?.rwa_assets?.[0] ?? null;
const all = (body) => body?.data?.rwa_assets ?? [];

export async function resolveAsset(client, query) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) throw new CmcError("Enter a ticker, name, or rwa_id.", { code: "EMPTY" });

  if (/^\d+$/.test(trimmed)) {
    return { rwa_id: Number(trimmed), matched_on: "rwa_id", candidates: [] };
  }

  const symbolHits = all(await client.map({ symbol: trimmed.toUpperCase() }));
  if (symbolHits.length) {
    // Several assets can share a ticker; CMC ranks by tokenized market cap.
    const ranked = [...symbolHits].sort(
      (a, b) => (a.rwa_rank ?? Infinity) - (b.rwa_rank ?? Infinity),
    );
    return {
      rwa_id: ranked[0].rwa_id,
      matched_on: "symbol",
      candidates: ranked.slice(1, 6),
    };
  }

  // Not a ticker: try it as a slug (e.g. "gold", "nvidia").
  const slug = trimmed.toLowerCase().replace(/\s+/g, "-");
  const slugHits = all(await client.info({ rwa_slug: slug, skip_invalid: true }));
  if (slugHits.length && slugHits[0].rwa_id) {
    return { rwa_id: slugHits[0].rwa_id, matched_on: "slug", candidates: [] };
  }

  throw new CmcError(
    `No tracked RWA asset matches "${trimmed}". Try a ticker such as NVDA, ` +
      `a slug such as gold, or a numeric rwa_id.`,
    { code: "NOT_FOUND" },
  );
}

export async function investigate(client, query) {
  const startedAt = Date.now();
  const resolution = await resolveAsset(client, query);
  const rwa_id = resolution.rwa_id;

  const quoteBody = await client.quotes({ rwa_id });
  const asset = first(quoteBody);
  if (!asset) {
    throw new CmcError(`CMC returned no market data for rwa_id ${rwa_id}.`, {
      code: "NO_QUOTE",
    });
  }

  let metadata = null;
  try {
    metadata = first(await client.info({ rwa_id }));
  } catch (err) {
    // Metadata is a nice-to-have; a report without it is still valid.
    metadata = { _error: err.message };
  }

  const tokens = Array.isArray(asset.tokens) ? asset.tokens : [];
  const issuers = await collectIssuers(client, tokens);
  const parity = computeParity(asset, tokens);

  return {
    query: String(query),
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    credits_used: client.creditsUsed(),

    resolution: {
      rwa_id,
      matched_on: resolution.matched_on,
      other_candidates: resolution.candidates.map((item) => ({
        rwa_id: item.rwa_id,
        name: item.name,
        symbol: item.symbol,
        rwa_rank: item.rwa_rank,
      })),
    },

    asset: {
      rwa_id: asset.rwa_id ?? rwa_id,
      name: asset.name ?? null,
      symbol: asset.symbol ?? null,
      slug: asset.slug ?? null,
      asset_type: asset.asset_type ?? null,
      rwa_rank: asset.rwa_rank ?? null,
      has_tokens: asset.has_tokens ?? tokens.length > 0,
    },

    metadata: metadata
      ? {
          website: metadata.website ?? null,
          // Where the underlying itself is listed, e.g. Nasdaq. CMC gives the
          // venue but no price from it.
          primary_exchange: metadata.primary_exchange ?? null,
          industry: metadata.industry ?? null,
          founded: metadata.founded ?? null,
          employees: metadata.employees ?? null,
          cik: metadata.cik ?? null,
          description: metadata.about?.description ?? null,
          logo: metadata.about?.logo ?? null,
          error: metadata._error ?? null,
        }
      : null,

    market: {
      average_tokenized_price: asset.average_tokenized_price ?? null,
      tokenized_market_cap: asset.tokenized_market_cap ?? null,
      tokenized_volume_24h: asset.tokenized_volume_24h ?? null,
      ...freshness(asset.last_updated),
    },

    issuers,
    venues: (asset.tradfi_markets ?? []).map((market) => ({
      exchange_id: market.exchange?.exchange_id ?? null,
      exchange_name: market.exchange?.name ?? null,
      exchange_slug: market.exchange?.slug ?? null,
      ticker: market.ticker ?? null,
      market_url: market.market_url ?? null,
    })),

    parity,
    evidence: client.evidence,
  };
}

async function collectIssuers(client, tokens) {
  const ids = [
    ...new Set(tokens.map((token) => token.issuer_id).filter(Boolean)),
  ];
  const known = new Map();
  for (const token of tokens) {
    if (token.issuer_id && !known.has(token.issuer_id)) {
      known.set(token.issuer_id, token.issuer_name ?? null);
    }
  }

  const issuers = [];
  for (const issuer_id of ids.slice(0, MAX_ISSUER_LOOKUPS)) {
    try {
      const body = await client.issuer({ issuer_id });
      const data = body?.data ?? {};
      issuers.push({
        issuer_id,
        name: data.name ?? known.get(issuer_id) ?? null,
        website: data.website ?? null,
        logo: data.logo ?? null,
        tokens_issued_total: Array.isArray(data.tokens) ? data.tokens.length : null,
        tokens_for_this_asset: tokens
          .filter((token) => token.issuer_id === issuer_id)
          .map((token) => token.symbol),
        lookup_error: null,
      });
    } catch (err) {
      issuers.push({
        issuer_id,
        name: known.get(issuer_id) ?? null,
        website: null,
        logo: null,
        tokens_issued_total: null,
        tokens_for_this_asset: tokens
          .filter((token) => token.issuer_id === issuer_id)
          .map((token) => token.symbol),
        lookup_error: err.message,
      });
    }
  }

  // Tokens whose issuer CMC does not track still deserve a row.
  const untracked = tokens.filter((token) => !token.issuer_id);
  if (untracked.length) {
    issuers.push({
      issuer_id: null,
      name: null,
      website: null,
      logo: null,
      tokens_issued_total: null,
      tokens_for_this_asset: untracked.map((token) => token.symbol),
      lookup_error: "CMC links no issuer to these tokens.",
    });
  }

  if (ids.length > MAX_ISSUER_LOOKUPS) {
    issuers.push({
      issuer_id: null,
      name: `${ids.length - MAX_ISSUER_LOOKUPS} more issuer(s) not fetched`,
      website: null,
      logo: null,
      tokens_issued_total: null,
      tokens_for_this_asset: [],
      lookup_error: `Capped at ${MAX_ISSUER_LOOKUPS} issuer lookups to limit credit use.`,
    });
  }

  return issuers;
}
