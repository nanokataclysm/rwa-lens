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

Requires Node.js 20 or newer. There are no packages to install or build step.

```bash
cp .env.example .env     # then paste your key into CMC_API_KEY
npm start                # http://localhost:8787
node cli.mjs NVDA        # same report in the terminal
node cli.mjs NVDA --json # the structured result
```

Set `CMC_API_KEY` in the environment or a local `.env` file. Live reports require
a key with access to the requested CoinMarketCap RWA endpoints and available
credits. The client reports missing keys, plan restrictions, and exhausted
limits explicitly; it does not fall back to a keyless API. Keep `.env` and API
keys out of version control.

The web server defaults to port 8787; set `PORT` to change it. Its current
listener uses all available interfaces and has no authentication, so use it only
in a trusted local environment. Requests to `/api/investigate?q=NVDA` consume
the configured key's API credits.

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

The deterministic tests use `fixtures/synthetic-nvda.json`,
a hand-built fixture with round numbers so every expected figure can be checked
on paper: deviation, spread, volume-weighted price, volume and market-cap shares,
freshness, ticker-versus-slug resolution, and graceful degradation when an issuer
or metadata lookup fails. The fixture is synthetic and labelled as such; it proves
the maths, not CMC's live response shape.

Additional tests inject mock HTTP responses to check retry limits, plan-access
errors, missing keys, and key exclusion from the request evidence log. The suite
runs without provider credentials or live API requests.

## Design

```
Browser  →  server.mjs  →  lib/cmc.mjs         REST client, retry, evidence log
                        →  lib/investigate.mjs orchestration, issuer fan-out
                        →  lib/parity.mjs      deterministic maths only
```

No dependencies, no build step, no database. `lib/parity.mjs` never sees an LLM
and an LLM never sees a calculation: identifier resolution, arithmetic and
comparison all happen in application code.

Issuer lookups are capped at five per report, and the footer shows the credit
use reported by the API for each report.

Plan limits and key/access errors stop immediately. Transient network errors,
selected server errors, and IP-level rate limits receive at most four attempts
with backoff. The evidence log records each received API response, including
retries, and sums its reported credit use.
