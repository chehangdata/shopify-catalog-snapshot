/**
 * collector.ts — Shopify catalogue snapshots, zero dependencies, Node >= 22.
 *
 * Written for the "published scraper" bar that serious ad-spy / data-platform
 * briefs set: one file, no installs, runs with plain `node collector.ts`.
 *
 * What it does per store: walks /products.json page by page (250/page), keeps a
 * per-host politeness delay, backs off exponentially on 429/5xx, treats 403 as
 * "blocked" instead of "empty catalogue", and writes an append-only snapshot so
 * day-over-day price and stock deltas are arithmetic.
 *
 * Usage:
 *   node collector.ts --domain allbirds.com --out out/run1 --pages 2
 *   node collector.ts --domains stores.txt --out out/daily --delay 1200
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PAGE = 250;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface Row {
  store: string;
  product_id: number;
  handle: string;
  title: string;
  vendor: string;
  product_type: string;
  price_min: number | null;
  price_max: number | null;
  compare_at_price: string | null;
  sku_first: string | null;
  available_first: boolean | null;
  variant_count: number;
  image_count: number;
  created_at: string | null;
  updated_at: string | null;
  snapshot_utc: string;
}

export interface StoreReport {
  store: string;
  status: string;
  products: number;
  pages: number;
}

interface ShopifyProduct {
  id: number;
  handle: string;
  title: string;
  vendor: string;
  product_type: string;
  created_at: string | null;
  updated_at: string | null;
  images?: unknown[];
  variants?: Array<{
    price?: string;
    compare_at_price?: string | null;
    sku?: string | null;
    available?: boolean;
  }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function normaliseStore(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return withScheme.replace(/\/+$/, "");
}

/** Collect one storefront; the returned status is explicit, never implied. */
export async function collectStore(
  store: string,
  delayMs: number,
  maxPages: number,
): Promise<{ report: StoreReport; rows: Row[] }> {
  const base = normaliseStore(store);
  const snapshot_utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const rows: Row[] = [];
  let status = "ok";
  let page = 1;

  for (; page <= maxPages; page++) {
    const url = `${base}/products.json?limit=${PAGE}&page=${page}`;
    let payload: { products?: ShopifyProduct[] } | null = null;

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { "user-agent": UA, accept: "application/json" },
          redirect: "follow",
        });
        if (!res.ok) {
          if ((res.status === 429 || res.status >= 500) && attempt < 4) {
            const wait = 2 ** attempt * 500 + Math.random() * 400;
            console.error(`  ${store} ${res.status} page ${page} — back off ${Math.round(wait)}ms`);
            await sleep(wait);
            continue;
          }
          status =
            res.status === 403
              ? "403 (blocked; no bypass attempted)"
              : res.status === 404
                ? "404 (no catalogue path)"
                : `http ${res.status}`;
          return { report: { store, status, products: rows.length, pages: page }, rows };
        }
        payload = (await res.json()) as { products?: ShopifyProduct[] };
        break;
      } catch (err) {
        if (attempt < 2) {
          await sleep(800 * (attempt + 1));
          continue;
        }
        status = `error ${(err as Error).name}`;
        return { report: { store, status, products: rows.length, pages: page }, rows };
      }
    }

    if (!payload || !Array.isArray(payload.products)) {
      status = "response had no products array (not Shopify, or JSON closed)";
      break;
    }
    if (payload.products.length === 0) break;

    for (const p of payload.products) {
      const variants = p.variants ?? [];
      const prices = variants
        .map((v) => Number(v.price))
        .filter((n) => Number.isFinite(n) && n > 0);
      const first = variants[0] ?? {};
      rows.push({
        store,
        product_id: p.id,
        handle: p.handle,
        title: p.title,
        vendor: p.vendor,
        product_type: p.product_type,
        price_min: prices.length ? Math.min(...prices) : null,
        price_max: prices.length ? Math.max(...prices) : null,
        compare_at_price: first.compare_at_price ?? null,
        sku_first: first.sku ?? null,
        available_first: first.available ?? null,
        variant_count: variants.length,
        image_count: (p.images ?? []).length,
        created_at: p.created_at,
        updated_at: p.updated_at,
        snapshot_utc,
      });
    }

    if (payload.products.length < PAGE) break;
    await sleep(delayMs);
  }

  return { report: { store, status, products: rows.length, pages: page }, rows };
}

const COLS: (keyof Row)[] = [
  "store", "product_id", "handle", "title", "vendor", "product_type",
  "price_min", "price_max", "compare_at_price", "sku_first", "available_first",
  "variant_count", "image_count", "created_at", "updated_at", "snapshot_utc",
];

function toCsv(rows: Row[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [COLS.join(","), ...rows.map((r) => COLS.map((c) => esc(r[c])).join(","))].join("\n");
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
function argAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

async function main() {
  const out = arg("out");
  if (!out) {
    console.error("need --out <prefix>");
    process.exit(2);
  }
  let stores = argAll("domain");
  const listFile = arg("domains");
  if (listFile) {
    stores = stores.concat(
      readFileSync(listFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    );
  }
  if (stores.length === 0) {
    console.error("need --domain or --domains");
    process.exit(2);
  }
  const delayMs = Number(arg("delay", "1000"));
  const maxPages = Number(arg("pages", "40"));

  mkdirSync(dirname(out) || ".", { recursive: true });
  const all: Row[] = [];
  const reports: StoreReport[] = [];

  for (const store of stores) {
    console.log(`[${store}]`);
    const { report, rows } = await collectStore(store, delayMs, maxPages);
    reports.push(report);
    all.push(...rows);
    console.log(`  -> ${rows.length} products, status=${report.status}`);
    await sleep(Math.max(delayMs, 500));
  }

  writeFileSync(`${out}.csv`, "\uFEFF" + toCsv(all), "utf8");
  writeFileSync(`${out}.jsonl`, all.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(`${out}-report.json`, JSON.stringify({ rows: all.length, stores: reports }, null, 2), "utf8");

  console.log(`\nrows=${all.length} -> ${out}.csv / .jsonl / -report.json`);
  for (const r of reports) {
    console.log(`  ${r.store.padEnd(28)} ${String(r.products).padStart(6)} products  ${r.status}`);
  }
}

main();
