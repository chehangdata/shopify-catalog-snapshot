# shopify-catalog-snapshot

Collect a public Shopify storefront catalogue into an append-only daily snapshot, so price and stock changes are arithmetic instead of eyeballing.

Zero dependencies. One file. Runs on plain Node:

```bash
node collector.ts --domain allbirds.com --out out/run1 --pages 2
node collector.ts --domains stores.txt --out out/daily --delay 1200
```

Real run (2 stores, 2 pages each, this machine):

```
allbirds.com                    356 products  ok
deathwishcoffee.com             158 products  ok
rows=514 -> out/run1.csv / .jsonl / -report.json
```

## What each row carries

`store, product_id, handle, title, vendor, product_type, price_min, price_max, compare_at_price, sku_first, available_first, variant_count, image_count, created_at, updated_at, snapshot_utc`

Two snapshots of the same store diff cleanly on `product_id`: new products appear, `price_min` moves, `available_first` flips to false = out of stock, a product that keeps its id but changes `handle` = renamed URL.

## Design decisions, and why

**Explicit per-store status.** The report separates `ok` from `403 (blocked; no bypass attempted)`, `404 (no catalogue path)`, `http 5xx`, `error <type>`, and `response had no products array (not Shopify, or JSON closed)`. An empty array means "this store genuinely has no public products"; a 403 means "we were refused". Collapsing those two into "0 products" is how a daily job silently rots.

**Per-host politeness.** `--delay` milliseconds between pages, 250 products per page. Default 1000 ms. A crawl of a few thousand stores is a scheduling problem, not a concurrency problem — hammering a host gets the whole run blocked.

**Back-off on 429 / 5xx, up to 4 retries** with exponential wait plus jitter, per page. A single blocked page does not throw away the pages already collected.

**Append-only snapshots.** Each run writes a new `<prefix>.csv / .jsonl / -report.json` with its own `snapshot_utc`. Nothing is overwritten, so history is recoverable and a bad run is identifiable by its timestamp.

**No bypass.** When the storefront returns 403, this tool records it and moves on. It does not rotate user agents to defeat a block, does not touch authenticated endpoints, and only reads the public catalogue path a storefront exposes to any browser.

## Scope and limits

- Only stores exposing `/products.json` (the default Shopify storefront route). Themes or apps that disable it return 404 and are reported as such.
- Prices are variant prices as published. Currency is whatever the storefront publishes; this tool does not convert.
- Inventory is `available` per variant, not a stock count — Shopify does not expose counts publicly.
- `--pages` caps depth per store, which is how you cap cost per refresh tier.

## Licence

MIT.
