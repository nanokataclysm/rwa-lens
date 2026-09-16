// Deterministic parity maths. No LLM touches any number in this file.
//
// What CMC's RWA endpoints DO return: an aggregate tokenized price plus a price
// for each individual token. What they do NOT return: the underlying asset's
// TradFi price. So parity here means token-vs-aggregate and token-vs-token
// dispersion; the comparison against the underlying is reported as unavailable
// rather than guessed at.

export const UNAVAILABLE = {
  tradfi_reference_price:
    "CMC's RWA endpoints return no underlying/TradFi price. " +
    "`tradfi_markets` lists crypto exchanges that trade the token, not the " +
    "reference market.",
  premium_vs_underlying:
    "Needs a TradFi reference price, which CMC does not return for RWA assets.",
};

const isNum = (value) => typeof value === "number" && Number.isFinite(value);

export function pct(part, whole) {
  if (!isNum(part) || !isNum(whole) || whole === 0) return null;
  return (part / whole) * 100;
}

export function deviation(price, reference) {
  if (!isNum(price) || !isNum(reference) || reference === 0) return null;
  return ((price - reference) / reference) * 100;
}

export function freshness(lastUpdated, now = Date.now()) {
  if (!lastUpdated) return { last_updated: null, age_seconds: null, stale: null };
  const then = Date.parse(lastUpdated);
  if (Number.isNaN(then)) {
    return { last_updated: lastUpdated, age_seconds: null, stale: null };
  }
  const age = Math.round((now - then) / 1000);
  return {
    last_updated: lastUpdated,
    age_seconds: age,
    // RWA market data is cached for 60s upstream, so anything past a few
    // minutes means the asset itself is not trading, not that we are slow.
    stale: age > 300,
  };
}

// Volume-weighted price across tokens. Differs from CMC's simple aggregate when
// one venue dominates volume, which is the interesting case for a buyer.
export function volumeWeightedPrice(tokens) {
  let weighted = 0;
  let volume = 0;
  for (const token of tokens) {
    if (isNum(token.price) && isNum(token.volume_24h) && token.volume_24h > 0) {
      weighted += token.price * token.volume_24h;
      volume += token.volume_24h;
    }
  }
  if (volume === 0) return null;
  return weighted / volume;
}

export function computeParity(asset, tokens) {
  const aggregate = isNum(asset.average_tokenized_price)
    ? asset.average_tokenized_price
    : null;

  const priced = tokens.filter((token) => isNum(token.price));
  const prices = priced.map((token) => token.price);

  const analysed = tokens.map((token) => ({
    ...token,
    deviation_pct_vs_aggregate: deviation(token.price, aggregate),
    share_of_tokenized_volume: pct(token.volume_24h, asset.tokenized_volume_24h),
    share_of_tokenized_market_cap: pct(
      token.market_cap,
      asset.tokenized_market_cap,
    ),
  }));

  const withDeviation = analysed.filter((token) =>
    isNum(token.deviation_pct_vs_aggregate),
  );
  const sorted = [...withDeviation].sort(
    (a, b) => b.deviation_pct_vs_aggregate - a.deviation_pct_vs_aggregate,
  );

  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  const vwap = volumeWeightedPrice(tokens);

  return {
    aggregate_tokenized_price: aggregate,
    volume_weighted_token_price: vwap,
    // A gap between CMC's simple aggregate and the volume-weighted price means
    // the cheapest or dearest token is not where the volume actually is.
    vwap_vs_aggregate_pct: deviation(vwap, aggregate),
    tokens_total: tokens.length,
    tokens_priced: priced.length,
    tokens_unpriced: tokens.length - priced.length,
    lowest_token_price: min,
    highest_token_price: max,
    spread_abs: isNum(min) && isNum(max) ? max - min : null,
    spread_pct: isNum(min) && isNum(max) && min !== 0 ? ((max - min) / min) * 100 : null,
    widest_premium: sorted.length ? summarise(sorted[0]) : null,
    widest_discount: sorted.length ? summarise(sorted[sorted.length - 1]) : null,
    tokens: analysed,
    unavailable: { ...UNAVAILABLE },
  };
}

function summarise(token) {
  return {
    symbol: token.symbol,
    name: token.name,
    issuer_name: token.issuer_name,
    price: token.price,
    deviation_pct_vs_aggregate: token.deviation_pct_vs_aggregate,
  };
}
