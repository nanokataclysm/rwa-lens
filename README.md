# RWA Lens

Evidence-first research for tokenized real-world assets, built on CoinMarketCap's
Real World Assets API.

Ask it about a tokenized asset and it answers the question a buyer actually has:

> If I buy the tokenized version of NVDA, what am I buying, who issued it, and
> how do the tokenized representations compare to each other?

Every number in a report is computed here from CoinMarketCap's response. The
report shows the exact calls that produced it, and says plainly when CMC does not
return something rather than filling the gap.

## Run it

```bash
cp .env.example .env     # then paste your key into CMC_API_KEY
npm start                # http://localhost:8787
node cli.mjs NVDA        # same report in the terminal
node cli.mjs NVDA --json # the structured result
```

A free CoinMarketCap **Basic** key covers all seven RWA endpoints. The keyless
public API does not: `/v5/real-world-assets/*` returns error 1005 without a key.

## What a report contains

| Section | Source |
| --- | --- |
| Asset identity, type, RWA rank | `/v5/real-world-assets/map`, `/quotes/latest` |
| Company metadata, description, logo | `/v5/real-world-assets/info` |
| Aggregate tokenized price, market cap, 24h volume, quote age | `/v5/real-world-assets/quotes/latest` |
| Every token representing the asset, with issuer and price | `/v5/real-world-assets/quotes/latest` |
| Issuer detail and token counts | `/v5/real-world-assets/issuers` |
| Exchanges trading the token | `/v5/real-world-assets/quotes/latest` (`tradfi_markets`) |
| Raw request/response evidence, credits, latency | recorded by the client |

## What CMC does not return, and what this does about it

The RWA endpoints carry **no underlying/TradFi price**. Despite its name,
`tradfi_markets` lists the crypto exchanges where the token trades, not the
reference market. A premium-or-discount against the underlying asset therefore
cannot be computed from this API, and the report says so instead of inventing a
number.

What it does compute, deterministically, from CMC's own figures:

- each token's deviation from the aggregate tokenized price
- the spread between the cheapest and dearest token
- a volume-weighted token price, and its gap from CMC's simple aggregate — they
  diverge when the volume is not where the best price is
- each token's share of tokenized volume and market cap
- quote freshness in seconds, flagged stale past five minutes

## Tests

```bash
npm test
```

Twelve tests cover the deterministic layer against `fixtures/synthetic-nvda.json`,
a hand-built fixture with round numbers so every expected figure can be checked
on paper: deviation, spread, volume-weighted price, volume and market-cap shares,
freshness, ticker-versus-slug resolution, and graceful degradation when an issuer
or metadata lookup fails. The fixture is synthetic and labelled as such; it proves
the maths, not CMC's live response shape.

## Design

```
Browser  →  server.mjs  →  lib/cmc.mjs         REST client, retry, evidence log
                        →  lib/investigate.mjs orchestration, issuer fan-out
                        →  lib/parity.mjs      deterministic maths only
```

No dependencies, no build step, no database. `lib/parity.mjs` never sees an LLM
and an LLM never sees a calculation: identifier resolution, arithmetic and
comparison all happen in application code.

Credit use is bounded: `/map` is free, issuer lookups are capped at five per
report, and the footer shows the credits each report spent.
