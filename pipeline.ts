/**
 * pipeline.ts — one command, one finished deliverable, from whatever source.
 *
 * This is the thing a client actually buys: not a scraper, a pipeline that takes
 * their source, snapshots it, says what changed since last time, and writes a
 * workbook-ready file plus a report they can audit. The source is pluggable
 * (see source.ts), so the same command works for a licensed vendor feed, a
 * Shopify catalogue, or a form-driven directory.
 *
 * Demo (offline, deterministic, includes a deliberately partial batch):
 *   node pipeline.ts --mock --out out/pipeline-demo
 *
 * Real source:
 *   node pipeline.ts --adapter adapter.demo.json --out out/daily
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { select, parseHtml, extractField, type Adapter } from "./search.ts";
import { collectAll, makeMockSource, normalise, type SourceAdapter } from "./source.ts";

/** Wrap the form crawler so a directory page looks like any other source. */
function httpSource(adapter: Adapter, maxPages: number): SourceAdapter {
  let page = adapter.first_page ?? 1;
  return {
    id: adapter.name,
    fields: adapter.fields,
    async fetchBatch(cursor?: string) {
      const p = Number(cursor ?? String(page));
      if (p > maxPages) return { rows: [], status: "ok" };
      const url = new URL(adapter.url);
      for (const [k, v] of Object.entries(adapter.params ?? {})) url.searchParams.set(k, v);
      if (adapter.page_param) url.searchParams.set(adapter.page_param, String(p));

      const res = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          accept: "text/html",
        },
      });
      if (res.status === 403) return { rows: [], status: "error", note: "403 blocked; not treated as empty" };
      if (!res.ok) return { rows: [], status: "error", note: `http ${res.status}` };

      const doc = parseHtml(await res.text());
      const found = select(doc, adapter.row_selector);
      const rows = found.map((r) => {
        const row: Record<string, unknown> = {};
        for (const [name, spec] of Object.entries(adapter.fields)) row[name] = extractField(r, spec);
        return row;
      });
      if (rows.length === 0) return { rows, status: "ok", note: "no rows on this page" };
      return { rows, status: "ok", next: String(p + 1) };
    },
  };
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function csv(rows: Record<string, unknown>[], cols: string[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

async function main() {
  const out = arg("out");
  if (!out) {
    console.error("need --out <prefix> (plus --mock or --adapter <file>)");
    process.exit(2);
  }

  const keyFields = (arg("keys", "sku") ?? "sku").split(",").map((s) => s.trim());

  let source: SourceAdapter;
  if (hasFlag("mock")) {
    source = makeMockSource();
  } else {
    const adapterPath = arg("adapter");
    if (!adapterPath) {
      console.error("need --mock or --adapter <file>");
      process.exit(2);
    }
    source = httpSource(JSON.parse(readFileSync(adapterPath, "utf8")) as Adapter, Number(arg("max-pages", "20")));
  }

  const collected = await collectAll(source);
  const { rows, dropped } = normalise(collected.rows, keyFields);

  // diff against the previous run, if any
  const prevPath = `${out}.jsonl`;
  const prev = existsSync(prevPath)
    ? new Map(
        readFileSync(prevPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const r = JSON.parse(l) as Record<string, unknown>;
            return [String(r.key), r];
          }),
      )
    : null;

  const changes: { key: string; kind: string; before: unknown; after: unknown }[] = [];
  if (prev) {
    const cur = new Map(rows.map((r) => [String(r.key), r]));
    for (const [k, r] of cur) {
      const p = prev.get(k);
      if (!p) changes.push({ key: k, kind: "new", before: null, after: r });
      else {
        for (const [field, v] of Object.entries(r)) {
          if (field === "key") continue;
          if (p[field] !== v) changes.push({ key: k, kind: `changed:${field}`, before: p[field], after: v });
        }
      }
    }
    // only claim removals when the new snapshot is complete; a partial run would
    // otherwise delete live rows simply because a vendor page failed
    if (collected.complete) {
      for (const [k, p] of prev) if (!cur.has(k)) changes.push({ key: k, kind: "gone", before: p, after: null });
    }
  }

  mkdirSync(dirname(out) || ".", { recursive: true });
  const cols = ["key", ...Object.keys(source.fields)];
  writeFileSync(`${out}.csv`, "\uFEFF" + csv(rows, cols), "utf8");
  writeFileSync(`${out}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(
    `${out}-report.json`,
    JSON.stringify(
      {
        source: source.id,
        snapshot_at: new Date().toISOString(),
        rows: rows.length,
        dropped_rows: dropped.length,
        dropped,
        batches: collected.notes,
        snapshot_status: collected.status,
        compared_to_previous: prev ? `${prev.size} rows` : "no previous snapshot",
        changes: prev ? changes.length : null,
        change_detail: changes,
        note: collected.complete
          ? "complete snapshot: removal detection allowed"
          : "partial snapshot: removals intentionally NOT reported",
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`${source.id}: ${rows.length} rows, ${dropped.length} dropped`);
  for (const n of collected.notes) console.log(`  batch ${n.batch}: ${n.status} ${n.rows} rows ${n.note ?? ""}`);
  console.log(`  snapshot: ${collected.status}`);
  if (prev) console.log(`  changes vs previous: ${changes.length}`);
  console.log(`-> ${out}.csv / .jsonl / -report.json`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) void main();
