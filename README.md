# shopify-catalog-snapshot

Collect a public Shopify storefront catalogue into an append-only daily snapshot, then diff two snapshots to see exactly what moved — new products, vanished products, price changes, stock flips.

Zero dependencies. Two files of logic. Runs on plain Node (>= 22, tested on 24):

```bash
node collector.ts --domain allbirds.com --out out/day1 --pages 2
node collector.ts --domain allbirds.com --out out/day2 --pages 2
node diff.ts      --prev out/day1.jsonl --cur out/day2.jsonl --out out/delta
node verify.ts    # offline self-test, 11 assertions, no network
```

Real run on this machine (2 stores, 2 pages each):

```
allbirds.com                    356 products  ok
deathwishcoffee.com             158 products  ok
rows=514 -> out/run1.csv / .jsonl / -report.json
```

## What each row carries

`store, product_id, handle, title, vendor, product_type, price_min, price_max, compare_at_price, sku_first, available_first, variant_count, image_count, created_at, updated_at, snapshot_utc`

Two snapshots of the same store diff cleanly on `product_id`: new products appear, `price_min` moves, `available_first` flips to false = out of stock, a product that keeps its id but changes `handle` = renamed URL.

## What the diff reports

`new · gone · price_up · price_down · stock_in · stock_out · renamed`

Each change carries store, product_id, title, before and after, so it can go straight into a spreadsheet or an alert. The summary file also lists stores that appear in only one of the two snapshots — **their rows are never treated as removed**, because "the store was not crawled today" and "the store emptied itself" are different facts and must not collapse into one.

## Design decisions, and why

**Explicit per-store status.** The report separates `ok` from `403 (blocked; no bypass attempted)`, `404 (no catalogue path)`, `http 5xx`, `error <type>`, and `response had no products array (not Shopify, or JSON closed)`. An empty array means "this store genuinely has no public products"; a 403 means "we were refused". Collapsing those two into "0 products" is how a daily job silently rots: the dashboard stays green while the data is empty.

**Per-host politeness.** `--delay` milliseconds between pages, 250 products per page, default 1000 ms. A crawl of a few thousand stores is a scheduling problem, not a concurrency problem — hammering a host gets the whole run blocked.

**Back-off on 429 / 5xx, up to 4 retries** with exponential wait plus jitter, per page. One refused page does not throw away the pages already collected.

**Append-only snapshots.** Each run writes a new `<prefix>.csv / .jsonl / -report.json` with its own `snapshot_utc`. Nothing is overwritten, so history is recoverable and a bad run is identifiable by its timestamp. `snapshot_utc` is also what makes a delta arithmetic instead of interpretation.

**No bypass.** When the storefront returns 403, this tool records it and moves on. It does not rotate user agents to defeat a block, does not touch authenticated endpoints, and only reads the public catalogue path a storefront exposes to any browser.

## Verifying it yourself

```bash
node verify.ts
```

Runs 11 offline assertions against the diff engine: price up vs price down are not confused, a missing product becomes `gone`, an availability flip becomes `stock_out`, a changed handle becomes `renamed`, identical snapshots produce zero changes, and every change carries the fields a CSV needs. No network, no fixtures to download — a test that needs a live storefront fails for reasons that have nothing to do with this code.

The network path is exercised by running the collector itself; the printed `status` column is the assertion you read.

## Scope and limits

- Only stores exposing `/products.json` (the default Shopify storefront route). Themes or apps that disable it return 404 and are reported as such.
- Prices are variant prices as published. Currency is whatever the storefront publishes; this tool does not convert.
- Inventory is `available` per variant, not a stock count — Shopify does not expose counts publicly.
- `--pages` caps depth per store, which is how you cap cost per refresh tier.

## Not built yet, on purpose

Listed so nobody has to discover it by reading the source:

- No scheduler and no alerting. The exit path prints a status per store; wiring that to cron plus a webhook is the caller's job, and every team already has a preferred one.
- No database writer. Snapshots are files here; loading them into Postgres (`(source, entity_id, run_id)` unique, `ON CONFLICT DO NOTHING`) is the intended next step and is described above rather than half-implemented.
- No proxy rotation. If a host blocks the IP, the run says blocked — that is a signal about the job, not a puzzle for the scraper to defeat.
- No Meta Ad Library or TikTok collector yet. Those need session-state handling and per-tier cost control, which is a different design, not a copy of this one.

## Licence

MIT.
