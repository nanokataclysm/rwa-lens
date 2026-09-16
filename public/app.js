const form = document.getElementById("search-form");
const input = document.getElementById("query");
const button = document.getElementById("submit");
const stage = document.getElementById("stage");
const creditNote = document.getElementById("credit-note");
const template = document.getElementById("report-template");

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const compact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const money = (value) => (isNum(value) ? usd.format(value) : null);
const moneyCompact = (value) => (isNum(value) ? compact.format(value) : null);
const signed = (value) =>
  isNum(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : null;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  run(input.value.trim());
});

run(input.value.trim());

async function run(query) {
  if (!query) return;
  button.disabled = true;
  button.textContent = "Reading CMC";
  showStatus(`Tracing ${query} through the CoinMarketCap RWA endpoints.`);

  try {
    const response = await fetch(`/api/investigate?q=${encodeURIComponent(query)}`);
    const payload = await response.json();
    if (!response.ok) {
      showError(payload);
      return;
    }
    render(payload);
  } catch (err) {
    showError({ error: `The report request failed: ${err.message}` });
  } finally {
    button.disabled = false;
    button.textContent = "Investigate";
  }
}

function showStatus(message) {
  stage.replaceChildren(el("p", { class: "status" }, message));
}

function showError(payload) {
  const box = el("div", { class: "status status-error" });
  box.append(el("p", {}, payload.error ?? "Something went wrong."));
  if (payload.code) {
    box.append(el("p", {}, [el("code", {}, `CMC error code ${payload.code}`)]));
  }
  if (payload.code === "NO_KEY") {
    box.append(
      el(
        "p",
        {},
        "Add a CoinMarketCap key to .env as CMC_API_KEY, then restart the server. The free Basic plan covers every RWA endpoint.",
      ),
    );
  }
  stage.replaceChildren(box);
}

function render(report) {
  const node = template.content.cloneNode(true);
  const pick = (name) => node.querySelector(`[data-region="${name}"]`);

  const { asset, metadata, market, parity, issuers, venues, evidence } = report;

  node.querySelector(".asset-name").textContent =
    `${asset.name ?? "Unnamed asset"}${asset.symbol ? ` (${asset.symbol})` : ""}`;

  const desc = node.querySelector(".asset-desc");
  if (metadata?.description) {
    desc.textContent = trim(metadata.description, 320);
  } else {
    desc.remove();
  }

  const logo = node.querySelector(".asset-logo");
  if (metadata?.logo) {
    logo.src = metadata.logo;
    logo.hidden = false;
  }

  facts(pick("identity"), [
    ["RWA ID", asset.rwa_id, { mono: true }],
    ["Asset type", readable(asset.asset_type)],
    ["RWA rank", isNum(asset.rwa_rank) ? `#${asset.rwa_rank}` : null],
    ["Tokens tracked", parity.tokens_total],
    ["Underlying listed on", metadata?.primary_exchange],
    ["Industry", metadata?.industry],
    ["Company site", metadata?.website, { link: true }],
  ]);

  facts(pick("market-facts"), [
    ["Aggregate tokenized price", money(parity.aggregate_tokenized_price)],
    ["Volume-weighted price", money(parity.volume_weighted_token_price)],
    ["Tokenized market cap", moneyCompact(market.tokenized_market_cap)],
    ["24h tokenized volume", moneyCompact(market.tokenized_volume_24h)],
    ["Quote age", isNum(market.age_seconds) ? `${market.age_seconds}s` : null],
  ]);

  pick("market-gap").textContent =
    `Not available from CoinMarketCap: the underlying market price. ${parity.unavailable.tradfi_reference_price} ` +
    `So this report compares tokens against each other and against the aggregate, never against the underlying.`;

  renderAxis(pick("axis"), pick("parity-note"), parity);
  renderIssuers(pick("issuer-grid"), issuers);
  renderTokens(pick("token-rows"), parity.tokens);
  renderVenues(pick("venues"), pick("venue-list"), venues);
  renderEvidence(pick("evidence"), evidence);

  creditNote.textContent = `${report.credits_used} CMC credit${
    report.credits_used === 1 ? "" : "s"
  } used · report built in ${report.elapsed_ms} ms`;

  stage.replaceChildren(node);
}

function renderAxis(host, note, parity) {
  const rows = parity.tokens.filter((token) =>
    isNum(token.deviation_pct_vs_aggregate),
  );

  if (!rows.length) {
    note.textContent = "CMC returned no per-token prices for this asset, so there is nothing to compare.";
    host.append(el("p", { class: "axis-empty" }, "No priced tokens."));
    return;
  }

  note.textContent =
    `Each token's price against the ${money(parity.aggregate_tokenized_price)} aggregate. ` +
    (isNum(parity.spread_pct)
      ? `Cheapest to dearest spans ${parity.spread_pct.toFixed(2)}%.`
      : "");

  const scale = Math.max(
    0.5,
    ...rows.map((token) => Math.abs(token.deviation_pct_vs_aggregate)),
  );

  host.append(
    el("div", { class: "axis-scale" }, [
      el("span", {}, "Token"),
      el("span", {}, [
        el("span", {}, `−${scale.toFixed(2)}%`),
        el("span", {}, "aggregate"),
        el("span", {}, `+${scale.toFixed(2)}%`),
      ]),
    ]),
  );

  const bars = [];
  for (const token of rows) {
    const value = token.deviation_pct_vs_aggregate;
    const direction = value >= 0 ? "up" : "down";
    const bar = el("div", { class: `axis-bar ${direction}` });
    bar.style.width = `${(Math.abs(value) / scale) * 50}%`;
    bar.style.setProperty("--grow", "0");
    bars.push(bar);

    host.append(
      el("div", { class: "axis-row" }, [
        el("div", { class: "axis-token" }, [
          document.createTextNode(token.symbol ?? "unnamed token"),
          el("span", {}, token.issuer_name ? ` ${token.issuer_name}` : ""),
        ]),
        el("div", { class: "axis-track" }, [bar]),
        el("div", { class: `axis-value ${direction}` }, signed(value)),
      ]),
    );
  }

  // One deliberate motion: the bars grow out from the aggregate line once.
  requestAnimationFrame(() => {
    for (const bar of bars) bar.style.setProperty("--grow", "1");
  });
}

function renderIssuers(host, issuers) {
  if (!issuers.length) {
    host.append(el("p", { class: "missing" }, "CMC lists no issuer for this asset."));
    return;
  }

  for (const issuer of issuers) {
    const card = el("div", { class: "issuer" });
    card.append(el("h3", {}, issuer.name ?? "Issuer not identified by CMC"));

    const tokens = issuer.tokens_for_this_asset.filter(Boolean);
    if (tokens.length) {
      card.append(el("p", {}, `Issues ${tokens.join(", ")}`));
    }
    if (isNum(issuer.tokens_issued_total)) {
      card.append(el("p", {}, `${issuer.tokens_issued_total} tokens issued in total`));
    }
    if (issuer.website) {
      card.append(el("p", {}, [el("a", { href: issuer.website, rel: "noreferrer noopener", target: "_blank" }, hostname(issuer.website))]));
    }
    if (issuer.issuer_id) {
      card.append(el("p", {}, [el("code", {}, issuer.issuer_id)]));
    }
    if (issuer.lookup_error) {
      card.append(el("p", { class: "missing" }, issuer.lookup_error));
    }
    host.append(card);
  }
}

function renderTokens(host, tokens) {
  if (!tokens.length) {
    host.append(
      el("tr", {}, [el("td", { colspan: "6", class: "missing" }, "CMC tracks no tokens for this asset.")]),
    );
    return;
  }

  for (const token of tokens) {
    const deviation = token.deviation_pct_vs_aggregate;
    const direction = isNum(deviation) ? (deviation >= 0 ? "up" : "down") : "";
    host.append(
      el("tr", {}, [
        el("td", {}, token.symbol ?? "—"),
        el("td", {}, token.issuer_name ?? mark("no issuer")),
        el("td", { class: "num" }, money(token.price) ?? mark("no price")),
        el("td", { class: `num ${direction}` }, signed(deviation) ?? mark("n/a")),
        el("td", { class: "num" }, moneyCompact(token.volume_24h) ?? mark("n/a")),
        el("td", { class: "num" }, moneyCompact(token.market_cap) ?? mark("n/a")),
      ]),
    );
  }
}

function renderVenues(section, host, venues) {
  if (!venues.length) {
    section.remove();
    return;
  }
  for (const venue of venues) {
    const row = el("li", {});
    row.append(el("span", {}, venue.exchange_name ?? "Unnamed exchange"));
    if (venue.ticker) row.append(el("code", {}, venue.ticker));
    if (venue.market_url) {
      row.append(
        el("a", { href: venue.market_url, rel: "noreferrer noopener", target: "_blank" }, "Open market"),
      );
    }
    host.append(row);
  }
}

function renderEvidence(host, evidence) {
  for (const item of evidence) {
    const details = el("details", {});
    const ok = item.error_code === "0";
    details.append(
      el("summary", {}, [
        el("span", {}, item.endpoint),
        el("span", {}, `${item.credit_count ?? 0} credit`),
        el("span", { class: ok ? "ok" : "bad" }, ok ? `${item.elapsed_ms} ms` : `error ${item.error_code}`),
      ]),
    );
    details.append(el("p", { class: "block-note" }, item.url));
    details.append(el("pre", {}, JSON.stringify(item.response, null, 2)));
    host.append(details);
  }
}

// Helpers ------------------------------------------------------------------

function facts(host, entries) {
  for (const [label, value, options = {}] of entries) {
    const dd = el("dd", {});
    if (value === null || value === undefined || value === "") {
      dd.className = "missing";
      dd.textContent = "not returned by CMC";
    } else if (options.link) {
      dd.append(el("a", { href: String(value), rel: "noreferrer noopener", target: "_blank" }, hostname(String(value))));
    } else {
      dd.textContent = String(value);
      if (options.mono) dd.className = "mono";
    }
    host.append(el("div", {}, [el("dt", {}, label), dd]));
  }
}

function mark(text) {
  return el("span", { class: "missing" }, text);
}

function readable(value) {
  return value ? String(value).replace(/_/g, " ") : null;
}

function trim(text, max) {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function el(tag, attrs = {}, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  if (children === null || children === undefined) return node;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}
