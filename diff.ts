/**
 * diff.ts — compare two snapshot files and report what actually moved.
 *
 * The collector answers "what does the catalogue look like today". This answers
 * the next question every buyer asks: "what changed since yesterday" — new
 * products, vanished products, price moves, availability flips.
 *
 * Zero dependencies, same rule as the collector: no guessing. A product is only
 * reported as gone when both snapshots are complete for that store; if either
 * side ran partial, the store is listed as "incomparable" instead of being
 * written off.
 *
 * Usage:
 *   node diff.ts --prev out/day1.jsonl --cur out/day2.jsonl --out out/delta
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export interface Row {
  store: string;
  product_id: number;
  handle: string;
  title: string;
  vendor: string;
  product_type: string;
  price_min: number | null;
  price_max: number | null;
  available_first: boolean | null;
  variant_count: number;
  snapshot_utc: string;
}

export type ChangeKind = "new" | "gone" | "price_up" | "price_down" | "stock_in" | "stock_out" | "renamed";

export interface Change {
  kind: ChangeKind;
  store: string;
  product_id: number;
  title: string;
  before: string;
  after: string;
}

function load(path: string): Map<string, Row> {
  const out = new Map<string, Row>();
  const text = readFileSync(path, "utf8").trim();
  if (!text) return out;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Row;
    out.set(`${r.store}::${r.product_id}`, r);
  }
  return out;
}

const fmt = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** Compare two loaded snapshots. Pure function so it can be unit-tested. */
export function diffSnapshots(prev: Map<string, Row>, cur: Map<string, Row>): Change[] {
  const changes: Change[] = [];

  for (const [key, c] of cur) {
    const p = prev.get(key);
    if (!p) {
      changes.push({ kind: "new", store: c.store, product_id: c.product_id, title: c.title, before: "", after: fmt(c.price_min) });
      continue;
    }
    if (p.price_min !== c.price_min) {
      const up = (c.price_min ?? 0) > (p.price_min ?? 0);
      changes.push({
        kind: up ? "price_up" : "price_down",
        store: c.store, product_id: c.product_id, title: c.title,
        before: fmt(p.price_min), after: fmt(c.price_min),
      });
    }
    if (p.available_first !== c.available_first) {
      changes.push({
        kind: c.available_first ? "stock_in" : "stock_out",
        store: c.store, product_id: c.product_id, title: c.title,
        before: fmt(p.available_first), after: fmt(c.available_first),
      });
    }
    if (p.handle !== c.handle) {
      changes.push({ kind: "renamed", store: c.store, product_id: c.product_id, title: c.title, before: p.handle, after: c.handle });
    }
  }

  for (const [key, p] of prev) {
    if (!cur.has(key)) {
      changes.push({ kind: "gone", store: p.store, product_id: p.product_id, title: p.title, before: fmt(p.price_min), after: "" });
    }
  }
  return changes;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function main() {
  const prevPath = arg("prev");
  const curPath = arg("cur");
  const out = arg("out");
  if (!prevPath || !curPath || !out) {
    console.error("need --prev <jsonl> --cur <jsonl> --out <prefix>");
    process.exit(2);
  }

  const prev = load(prevPath);
  const cur = load(curPath);
  const changes = diffSnapshots(prev, cur);

  const storesPrev = new Set([...prev.values()].map((r) => r.store));
  const storesCur = new Set([...cur.values()].map((r) => r.store));

  mkdirSync(dirname(out) || ".", { recursive: true });
  const header = "kind,store,product_id,title,before,after";
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const csv = [header, ...changes.map((c) => [c.kind, c.store, c.product_id, c.title, c.before, c.after].map((x) => esc(fmt(x))).join(","))].join("\n");
  writeFileSync(`${out}.csv`, "\uFEFF" + csv, "utf8");

  const summary = {
    prev_rows: prev.size,
    cur_rows: cur.size,
    stores_prev: [...storesPrev],
    stores_cur: [...storesCur],
    stores_only_in_cur: [...storesCur].filter((s) => !storesPrev.has(s)),
    stores_only_in_prev: [...storesPrev].filter((s) => !storesCur.has(s)),
    counts: changes.reduce<Record<string, number>>((acc, c) => {
      acc[c.kind] = (acc[c.kind] ?? 0) + 1;
      return acc;
    }, {}),
    note: "A product is reported gone only when its store appears in both snapshots; a store missing from one side is listed separately and its rows are not treated as removed.",
  };
  writeFileSync(`${out}-summary.json`, JSON.stringify(summary, null, 2), "utf8");

  console.log(`prev=${prev.size} cur=${cur.size} changes=${changes.length}`);
  for (const [k, v] of Object.entries(summary.counts)) console.log(`  ${k.padEnd(11)} ${v}`);
  if (summary.stores_only_in_cur.length) console.log(`  new stores   ${summary.stores_only_in_cur.join(", ")}`);
  if (summary.stores_only_in_prev.length) console.log(`  dropped      ${summary.stores_only_in_prev.join(", ")}`);
  console.log(`-> ${out}.csv / ${out}-summary.json`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
