#!/usr/bin/env node
// Same investigation as the web UI, printed to the terminal.
//   node cli.mjs NVDA
//   node cli.mjs NVDA --json

import { createClient, loadApiKey } from "./lib/cmc.mjs";
import { investigate } from "./lib/investigate.mjs";

const args = process.argv.slice(2);
const wantsJson = args.includes("--json");
const query = args.find((arg) => !arg.startsWith("--")) ?? "NVDA";

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const usd = (value) =>
  isNum(value)
    ? value.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "not returned by CMC";
const pct = (value) =>
  isNum(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "n/a";

try {
  const client = createClient({ apiKey: loadApiKey() });
  const report = await investigate(client, query);

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const { asset, market, parity, issuers, venues } = report;
  console.log(`\n${asset.name ?? "?"} (${asset.symbol ?? "?"})`);
  console.log(
    `rwa_id ${asset.rwa_id} · ${asset.asset_type ?? "type unknown"} · rank ${asset.rwa_rank ?? "?"} · matched on ${report.resolution.matched_on}`,
  );

  console.log("\nTokenized market");
  console.log(`  aggregate price      ${usd(parity.aggregate_tokenized_price)}`);
  console.log(`  volume-weighted      ${usd(parity.volume_weighted_token_price)}`);
  console.log(`  market cap           ${usd(market.tokenized_market_cap)}`);
  console.log(`  24h volume           ${usd(market.tokenized_volume_24h)}`);
  console.log(`  quote age            ${market.age_seconds ?? "?"}s`);

  console.log("\nToken representations");
  for (const token of parity.tokens) {
    console.log(
      `  ${(token.symbol ?? "?").padEnd(12)} ${usd(token.price).padStart(14)}` +
        `  ${pct(token.deviation_pct_vs_aggregate).padStart(8)}  ${token.issuer_name ?? "issuer not tracked"}`,
    );
  }
  if (isNum(parity.spread_pct)) {
    console.log(`  spread cheapest→dearest: ${parity.spread_pct.toFixed(2)}%`);
  }

  console.log("\nIssuers");
  for (const issuer of issuers) {
    console.log(
      `  ${(issuer.name ?? "not identified").padEnd(24)} ${issuer.tokens_for_this_asset.join(", ") || "-"}`,
    );
  }

  if (venues.length) {
    console.log("\nTrades on");
    for (const venue of venues) {
      console.log(`  ${venue.exchange_name ?? "?"}  ${venue.ticker ?? ""}`);
    }
  }

  console.log("\nNot available from CMC");
  for (const [field, why] of Object.entries(parity.unavailable)) {
    console.log(`  ${field}: ${why}`);
  }

  console.log("\nEvidence");
  for (const item of client.evidence) {
    console.log(
      `  ${item.endpoint.padEnd(42)} ${item.http_status} code ${item.error_code} ${item.credit_count ?? 0} credit ${item.elapsed_ms}ms`,
    );
  }
  console.log(`\n${report.credits_used} credits · ${report.elapsed_ms} ms\n`);
} catch (err) {
  console.error(`\nrwa-lens: ${err.message}\n`);
  process.exit(1);
}
