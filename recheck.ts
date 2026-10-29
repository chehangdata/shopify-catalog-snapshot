/**
 * recheck.ts — re-validate rows you already delivered, and say what changed.
 *
 * Why this exists: the most common follow-on ask in scraping work is not "scrape
 * more", it is "is this list still current?". A client hands back a spreadsheet
 * of 5,000 product URLs eight weeks later and wants to know which rows moved,
 * which died, and which now fail. That is a different job from collecting fresh
 * data, and it needs its own report shape.
 *
 * Zero dependencies. Same rule as the rest of the repo: a row is never reported
 * "gone" because a fetch failed — failure and absence are different statuses.
 *
 * Usage:
 *   node recheck.ts --rows out/day1.jsonl --out out/recheck --delay 800
 *   node recheck.ts --csv products.csv --url-column url --out out/recheck
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type RecheckStatus = "unchanged" | "price_changed" | "unavailable" | "gone" | "not_found" | "error";

export interface Target {
  store: string;
  product_id: number | string;
  handle: string;
  url: string;
  price_before: number | null;
}

export interface RecheckResult extends Target {
  status: RecheckStatus;
  price_now: number | null;
  detail: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function normaliseStore(s: string): string {
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  return withScheme.replace(/\/+$/, "");
}

/** Build the cheapest public endpoint for one product on a Shopify store. */
export function productEndpoint(t: Target): string {
  const base = normaliseStore(t.store);
  const handle = t.handle.trim();
  return handle ? `${base}/products/${encodeURIComponent(handle)}.json` : "";
}

async function fetchProduct(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, redirect: "follow" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * Decide a row's status from one probe. Pure enough to unit-test:
 * the caller supplies what the network returned.
 */
export function classify(
  before: number | null,
  httpStatus: number,
  body: unknown,
): { status: RecheckStatus; price: number | null; detail: string } {
  if (httpStatus === 404) {
    return { status: "gone", price: null, detail: "404 — product endpoint no longer exists" };
  }
  if (httpStatus === 403) {
    return { status: "error", price: null, detail: "403 — blocked; not treated as gone" };
  }
  if (httpStatus >= 500) {
    return { status: "error", price: null, detail: `http ${httpStatus} — server error; not treated as gone` };
  }

  type Variant = { price?: string; available?: boolean; inventory_quantity?: number; inventory_policy?: string };
  const product = (body as { product?: { variants?: Variant[] } } | null)?.product;
  if (!product) {
    return { status: "not_found", price: null, detail: "200 but no product in payload" };
  }
  const variants = product.variants ?? [];
  const prices = variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n) && n > 0);
  const price = prices.length ? Math.min(...prices) : null;

  // The single-product endpoint does NOT return `available` — it returns
  // inventory_quantity plus inventory_policy. Reading a missing `available` as
  // false would report every live product as out of stock, which is the same
  // class of lie as calling a blocked store an empty catalogue.
  const stockFlags = variants.map((v) => {
    if (typeof v.available === "boolean") return v.available;
    if (typeof v.inventory_quantity === "number") {
      return v.inventory_quantity > 0 || v.inventory_policy === "continue";
    }
    return null;
  });
  const known = stockFlags.filter((f): f is boolean => f !== null);

  if (known.length === 0) {
    return {
      status: before === null ? "not_found" : "error",
      price,
      detail: "stock not exposed by this endpoint — refused to guess availability",
    };
  }
  if (!known.some(Boolean)) {
    return { status: "unavailable", price, detail: "all variants out of stock (inventory evidence present)" };
  }
  if (before !== null && price !== null && price !== before) {
    return { status: "price_changed", price, detail: `${before} -> ${price}` };
  }
  return { status: "unchanged", price, detail: "" };
}

export async function recheck(targets: Target[], delayMs: number): Promise<RecheckResult[]> {
  const out: RecheckResult[] = [];
  for (const t of targets) {
    const url = productEndpoint(t);
    if (!url) {
      out.push({ ...t, status: "error", price_now: null, detail: "no handle — cannot build endpoint" });
      continue;
    }
    let attempt = 0;
    for (;;) {
      try {
        const { status, body } = await fetchProduct(url);
        const c = classify(t.price_before, status, body);
        out.push({ ...t, status: c.status, price_now: c.price, detail: c.detail });
        break;
      } catch (e) {
        if (attempt < 2) {
          await sleep(1000 * (attempt + 1));
          attempt++;
          continue;
        }
        out.push({ ...t, status: "error", price_now: null, detail: `network ${(e as Error).name}` });
        break;
      }
    }
    await sleep(delayMs);
  }
  return out;
}

function loadTargets(rowsPath: string): Target[] {
  const text = readFileSync(rowsPath, "utf8").trim();
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => {
    const r = JSON.parse(line) as { store?: string; product_id?: number; handle?: string; price_min?: number | null; url?: string };
    return {
      store: r.store ?? "",
      product_id: r.product_id ?? "",
      handle: r.handle ?? "",
      url: r.url ?? "",
      price_before: typeof r.price_min === "number" ? r.price_min : null,
    };
  });
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const rows = arg("rows");
  const outPrefix = arg("out");
  if (!rows || !outPrefix) {
    console.error("need --rows <jsonl> --out <prefix>");
    process.exit(2);
  }
  const delayMs = Number(arg("delay", "800"));
  const targets = loadTargets(rows);
  const results = await recheck(targets, delayMs);

  mkdirSync(dirname(outPrefix) || ".", { recursive: true });
  const header = "store,product_id,handle,status,price_before,price_now,detail";
  const esc = (s: unknown) => {
    const v = s === null || s === undefined ? "" : String(s);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const csv = [header, ...results.map((r) => [r.store, r.product_id, r.handle, r.status, r.price_before, r.price_now, r.detail].map(esc).join(","))].join("\n");
  writeFileSync(`${outPrefix}.csv`, "\uFEFF" + csv, "utf8");

  const counts = results.reduce<Record<string, number>>((a, r) => {
    a[r.status] = (a[r.status] ?? 0) + 1;
    return a;
  }, {});
  writeFileSync(`${outPrefix}-summary.json`, JSON.stringify({ checked: results.length, counts }, null, 2), "utf8");

  console.log(`checked ${results.length}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(14)} ${v}`);
  console.log(`-> ${outPrefix}.csv / ${outPrefix}-summary.json`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) void main();
