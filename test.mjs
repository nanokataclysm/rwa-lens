// Checks the deterministic layer against hand-computed values.
//   node --test test.mjs
//
// The fixture is synthetic, chosen so every expected number can be verified on
// paper. These tests prove the maths, not CMC's live response shape.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { computeParity, deviation, freshness, volumeWeightedPrice } from "./lib/parity.mjs";
import { investigate, resolveAsset } from "./lib/investigate.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/synthetic-nvda.json", import.meta.url)));
const asset = fx.quotes.data.rwa_assets[0];
const near = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} !== ${expected}`);

function stubClient(overrides = {}) {
  const calls = [];
  const client = {
    evidence: [],
    creditsUsed: () => 7,
    map: async (params) => (calls.push(["map", params]), overrides.map ?? fx.map),
    info: async (params) => (calls.push(["info", params]), overrides.info ?? fx.info),
    quotes: async (params) => (calls.push(["quotes", params]), fx.quotes),
    issuer: async ({ issuer_id }) => {
      calls.push(["issuer", issuer_id]);
      if (overrides.issuerFails) throw new Error("issuer lookup failed");
      return issuer_id.startsWith("a") ? fx.issuerAlpha : fx.issuerBeta;
    },
  };
  return { client, calls };
}

test("deviation handles nulls and zero reference", () => {
  near(deviation(101, 100), 1);
  near(deviation(98, 100), -2);
  assert.equal(deviation(null, 100), null);
  assert.equal(deviation(101, null), null);
  assert.equal(deviation(101, 0), null);
});

test("volume-weighted price ignores unpriced and zero-volume tokens", () => {
  // (101*1000 + 98*3000) / 4000 = 98.75
  near(volumeWeightedPrice(asset.tokens), 98.75);
  assert.equal(volumeWeightedPrice([{ price: 5, volume_24h: 0 }]), null);
  assert.equal(volumeWeightedPrice([{ price: null, volume_24h: 10 }]), null);
});

test("parity maths match hand calculation", () => {
  const parity = computeParity(asset, asset.tokens);

  near(parity.aggregate_tokenized_price, 100);
  assert.equal(parity.tokens_total, 3);
  assert.equal(parity.tokens_priced, 2);
  assert.equal(parity.tokens_unpriced, 1);

  near(parity.lowest_token_price, 98);
  near(parity.highest_token_price, 101);
  near(parity.spread_abs, 3);
  near(parity.spread_pct, (3 / 98) * 100);

  near(parity.volume_weighted_token_price, 98.75);
  near(parity.vwap_vs_aggregate_pct, -1.25);

  assert.equal(parity.widest_premium.symbol, "FIXa");
  near(parity.widest_premium.deviation_pct_vs_aggregate, 1);
  assert.equal(parity.widest_discount.symbol, "FIXb");
  near(parity.widest_discount.deviation_pct_vs_aggregate, -2);

  const [a, b, c] = parity.tokens;
  near(a.share_of_tokenized_volume, 20);
  near(b.share_of_tokenized_volume, 60);
  near(a.share_of_tokenized_market_cap, 40);
  assert.equal(c.deviation_pct_vs_aggregate, null);
  assert.equal(c.share_of_tokenized_volume, null);
});

test("unavailable fields are declared, never computed", () => {
  const parity = computeParity(asset, asset.tokens);
  assert.ok(parity.unavailable.tradfi_reference_price.includes("no underlying"));
  assert.ok(parity.unavailable.premium_vs_underlying.length > 0);
  assert.equal("premium_vs_underlying" in parity, false);
  assert.equal("underlying_price" in parity, false);
});

test("an asset with no tokens produces nulls, not NaN", () => {
  const empty = { average_tokenized_price: null, tokenized_market_cap: null, tokenized_volume_24h: null };
  const parity = computeParity(empty, []);
  assert.equal(parity.tokens_total, 0);
  assert.equal(parity.spread_pct, null);
  assert.equal(parity.widest_premium, null);
  assert.equal(parity.volume_weighted_token_price, null);
});

test("freshness reports age and staleness", () => {
  const base = Date.parse("2026-09-16T12:00:00.000Z");
  assert.deepEqual(freshness("2026-09-16T12:00:00.000Z", base + 41_000), {
    last_updated: "2026-09-16T12:00:00.000Z",
    age_seconds: 41,
    stale: false,
  });
  assert.equal(freshness("2026-09-16T12:00:00.000Z", base + 400_000).stale, true);
  assert.equal(freshness(null).age_seconds, null);
});

test("ticker resolution prefers the better-ranked asset and keeps the rest", async () => {
  const { client } = stubClient();
  const result = await resolveAsset(client, "nvda");
  assert.equal(result.rwa_id, 42);
  assert.equal(result.matched_on, "symbol");
  assert.equal(result.candidates[0].rwa_id, 99);
});

test("a non-ticker query falls back to the slug lookup", async () => {
  const { client, calls } = stubClient({ map: { data: { rwa_assets: [] } } });
  const result = await resolveAsset(client, "Fixture Semis");
  assert.equal(result.matched_on, "slug");
  assert.equal(result.rwa_id, 42);
  assert.deepEqual(calls.at(-1), ["info", { rwa_slug: "fixture-semis", skip_invalid: true }]);
});

test("a numeric query skips resolution entirely", async () => {
  const { client, calls } = stubClient();
  const result = await resolveAsset(client, "42");
  assert.equal(result.rwa_id, 42);
  assert.equal(result.matched_on, "rwa_id");
  assert.equal(calls.length, 0);
});

test("investigate assembles the full report", async () => {
  const { client } = stubClient();
  const report = await investigate(client, "NVDA");

  assert.equal(report.asset.rwa_id, 42);
  assert.equal(report.asset.asset_type, "stock");
  assert.equal(report.metadata.primary_exchange, "Nasdaq");
  assert.equal(report.metadata.cik, "0001045810");
  near(report.market.tokenized_volume_24h, 5000);
  near(report.parity.spread_abs, 3);

  // Two tracked issuers plus one row for the token CMC links to nobody.
  assert.equal(report.issuers.length, 3);
  assert.deepEqual(report.issuers[0].tokens_for_this_asset, ["FIXa"]);
  assert.equal(report.issuers[0].tokens_issued_total, 2);
  assert.equal(report.issuers.at(-1).issuer_id, null);
  assert.match(report.issuers.at(-1).lookup_error, /links no issuer/);

  assert.equal(report.venues[0].exchange_name, "Fixture Exchange");
  assert.equal(report.venues[0].ticker, "FIXa/USDT");
});

test("a failed issuer lookup degrades to a labelled row", async () => {
  const { client } = stubClient({ issuerFails: true });
  const report = await investigate(client, "NVDA");
  assert.match(report.issuers[0].lookup_error, /issuer lookup failed/);
  assert.equal(report.issuers[0].name, "Issuer Alpha"); // kept from the quote
});

test("metadata failure does not sink the report", async () => {
  const { client } = stubClient();
  client.info = async () => {
    throw new Error("info exploded");
  };
  const report = await investigate(client, "42");
  assert.match(report.metadata.error, /info exploded/);
  assert.equal(report.asset.symbol, "NVDA");
});

// --- HTTP client retry behaviour ------------------------------------------
// Plan limits must fail on the first response; only transient faults retry.

import { createClient, CmcError } from "./lib/cmc.mjs";

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return {
      ok: next.http < 400,
      status: next.http,
      json: async () => ({
        data: next.data ?? null,
        status: { error_code: next.code, error_message: next.message ?? "", credit_count: 1, timestamp: "t" },
      }),
    };
  };
  return { fetchImpl, calls };
}

for (const [code, expected] of [
  ["1008", /60 seconds/],
  ["1009", /00:00 UTC/],
  ["1010", /renewal date/],
]) {
  test(`plan limit ${code} fails on the first response`, async () => {
    const { fetchImpl, calls } = fakeFetch([{ http: 429, code }]);
    const client = createClient({ apiKey: "test", fetchImpl });
    await assert.rejects(() => client.map({ symbol: "NVDA" }), (err) => {
      assert.ok(err instanceof CmcError);
      assert.equal(err.code, code);
      assert.match(err.message, expected);
      return true;
    });
    assert.equal(calls.length, 1, "must not burn retries on a plan limit");
  });
}

test("a plan that lacks the endpoint says so, without retrying", async () => {
  const { fetchImpl, calls } = fakeFetch([{ http: 403, code: "1006" }]);
  const client = createClient({ apiKey: "test", fetchImpl });
  await assert.rejects(() => client.quotes({ rwa_id: 1 }), /Basic or higher/);
  assert.equal(calls.length, 1);
});

test("an IP rate limit retries and can succeed", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { http: 429, code: "1011" },
    { http: 200, code: "0", data: { rwa_assets: [] } },
  ]);
  const client = createClient({ apiKey: "test", fetchImpl });
  const body = await client.map({ symbol: "NVDA" });
  assert.deepEqual(body.data, { rwa_assets: [] });
  assert.equal(calls.length, 2);
  assert.equal(client.evidence.length, 2, "both attempts are recorded as evidence");
  assert.equal(client.evidence[0].attempt, 1);
  assert.equal(client.evidence[1].attempt, 2);
});

test("a 500 retries, a 400 does not", async () => {
  const good = fakeFetch([{ http: 500, code: "500" }, { http: 200, code: "0" }]);
  await createClient({ apiKey: "test", fetchImpl: good.fetchImpl }).map({});
  assert.equal(good.calls.length, 2);

  const bad = fakeFetch([{ http: 400, code: "1000", message: "bad request" }]);
  await assert.rejects(
    () => createClient({ apiKey: "test", fetchImpl: bad.fetchImpl }).map({}),
    /bad request/,
  );
  assert.equal(bad.calls.length, 1);
});

test("the API key never reaches the evidence log", async () => {
  const { fetchImpl } = fakeFetch([{ http: 200, code: "0" }]);
  const client = createClient({ apiKey: "super-secret-key", fetchImpl });
  await client.map({ symbol: "NVDA" });
  assert.equal(JSON.stringify(client.evidence).includes("super-secret-key"), false);
});

test("no key is a clear failure, not a network call", () => {
  assert.throws(() => createClient({ apiKey: null }), (err) => {
    assert.equal(err.code, "NO_KEY");
    assert.match(err.message, /free Basic plan/);
    return true;
  });
});
