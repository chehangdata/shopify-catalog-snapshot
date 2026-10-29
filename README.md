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

## Re-checking a list you already delivered

The most common follow-on ask is not "scrape more", it is "is this list still current?" — a client hands back a spreadsheet eight weeks later and wants to know which rows moved, which died, and which now fail.

```bash
node recheck.ts --rows out/day1.jsonl --out out/recheck --delay 800
```

Statuses: `unchanged · price_changed · unavailable · gone · not_found · error`.

The distinction that matters: **404 is `gone`, 403 is `error`.** A blocked fetch is never reported as a dead product, because the client would delete a live row on the strength of it.

### The bug this tool found in itself

First live run reported all four test rows as `unavailable`. They were not — the single-product endpoint simply does not return an `available` field; it returns `inventory_quantity` and `inventory_policy`. Reading a missing boolean as `false` turned "field absent" into "out of stock", which is exactly the lie the collector's status contract exists to prevent.

Fixed by reading stock from three sources in order (`available` → `inventory_quantity`/`inventory_policy` → refuse), and covered by an assertion that will fail if anyone reintroduces the shortcut:

```
ok  missing available + inventory_quantity>0 is NOT unavailable
ok  no stock evidence at all refuses to guess
```

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

## Sites that only expose data through a search form

`collector.ts` needs a JSON endpoint. Most real directories do not have one: they have a search box, a page parameter, and an HTML table. `search.ts` drives that from a JSON adapter, so a new site is a new adapter file rather than a new program.

```bash
node search.ts --adapter adapter.demo.json --out out/run1 --max-pages 3
```

Live run against a public practice directory:

```
scrapethissite.com hockey teams: 75 rows over 3 page(s) — ok (page cap reached)
team,year,wins,losses,win_pct
Boston Bruins,1990,44,24,0.55
```

The adapter is small and declarative:

```json
{
  "url": "https://site.example/search",
  "page_param": "page",
  "row_selector": "tr.team",
  "fields": { "team": "td.name", "year": "td.year", "wins": "td.wins" },
  "stop_when_missing": "tr.team"
}
```

Selectors support `tag`, `.class`, `#id`, `[attr=value]` (also `^=` `$=` `*=`), descendant combinators, and `selector@attr` to read an attribute instead of text.

**On reusing libraries.** The honest options were [Crawlee](https://github.com/apify/crawlee) (full crawler framework with proxy rotation and browser fallbacks) and [cheerio](https://github.com/cheeriojs/cheerio) / [linkedom](https://github.com/WebReflection/linkedom) for parsing. Both are good and both would have worked. The engine stays dependency-free anyway, because the first thing a client does with this repo is `git clone && node ...` — requiring an install turns a five-second test into a fifteen-minute setup, and every extra dependency is one more thing that can fail on their machine. What is in here instead is a 90-line tolerant parser plus the selector subset that directory pages actually use, covered by 11 assertions.

If you do want cheerio, it drops in where `select()` is called; the adapter format does not change.

**Failure honesty, again.** A run that gets `http 419` from a rate-limiting host reports `0 rows — http 419`, not an empty dataset. A run whose selectors match nothing says `0 rows on the first page — selectors do not match`, because "my selectors are wrong" and "this site has no results" are different problems and only one of them is fixed by waiting.
