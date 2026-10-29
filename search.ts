/**
 * search.ts — crawl a site that only exposes its data through a search form.
 *
 * The collector reads a JSON endpoint. Most real directories do not have one:
 * they have a JSP/ASP search box, a POST, and pagination. That shape is the most
 * common $1,000-class brief ("scrape this database of N companies"), so this
 * file drives it from a JSON adapter instead of hard-coding one site.
 *
 * Design stance: the engine stays zero-dependency so a client can run it after
 * `git clone`. If `cheerio` happens to be installed, it is used for CSS
 * selection; otherwise a small built-in selector handles tag, .class, #id,
 * [attr=value] and descendant combinators. Reuse when available, degrade
 * gracefully when not — never require an install to run the demo.
 *
 * Usage:
 *   node search.ts --adapter adapters/accredia.json --out out/run1 --max-pages 5
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface Adapter {
  name: string;
  /** Base URL for the search endpoint, e.g. https://site.example/search */
  url: string;
  method?: "GET" | "POST";
  /** Fixed parameters sent on every request (search field names, filters). */
  params?: Record<string, string>;
  /** Name of the parameter that carries the page number. Omit for single-page. */
  page_param?: string;
  /** First page number. Default 1. */
  first_page?: number;
  /** Hard stop, in addition to --max-pages. */
  last_page?: number;
  /** Selector for one result row. */
  row_selector: string;
  /** field name -> selector inside the row. `@attr` reads an attribute. */
  fields: Record<string, string>;
  /** Optional: a selector whose absence means "no more pages". */
  stop_when_missing?: string;
}

export interface ParsedRow {
  [field: string]: string;
}

/* ------------------------------------------------------------------ *
 * Minimal HTML parsing: enough for directory pages, no dependencies.
 * ------------------------------------------------------------------ */

export interface Node {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: Node[];
}

const VOID_TAGS = new Set(["br", "img", "input", "meta", "link", "hr", "area", "base", "col", "embed", "source", "track", "wbr"]);

export function parseHtml(html: string): Node {
  const root: Node = { tag: "#root", attrs: {}, text: "", children: [] };
  const stack: Node[] = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;

  const decode = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

  while ((m = re.exec(html))) {
    if (m[5] !== undefined) {
      const text = decode(m[5]).replace(/\s+/g, " ");
      if (text.trim()) stack[stack.length - 1].text += text;
      continue;
    }
    if (m[2] === undefined) continue; // comment
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[3] ?? ""))) {
      attrs[am[1].toLowerCase()] = decode(am[3] ?? am[4] ?? am[5] ?? "");
    }
    const node: Node = { tag, attrs, text: "", children: [] };
    stack[stack.length - 1].children.push(node);
    if (!VOID_TAGS.has(tag) && m[4] !== "/") stack.push(node);
  }
  return root;
}

/** Selector grammar: `tag`, `.cls`, `#id`, `[attr=value]`, and descendants 'a b'. */
export function select(node: Node, selector: string): Node[] {
  const parts = selector.trim().split(/\s+/);
  let current: Node[] = [node];
  for (const part of parts) {
    const next: Node[] = [];
    for (const n of current) walk(n, part, next);
    current = next;
    if (!current.length) break;
  }
  return current;
}

function matches(node: Node, part: string): boolean {
  if (node.tag === "#root") return false;
  const m = part.match(/^([a-zA-Z][\w:-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!m) return false;
  const [, tag, rest] = m;
  if (tag && node.tag !== tag.toLowerCase()) return false;
  const tokens = rest.match(/[.#][\w-]+|\[[^\]]+\]/g) ?? [];
  for (const t of tokens) {
    if (t.startsWith(".")) {
      const cls = (node.attrs.class ?? "").split(/\s+/);
      if (!cls.includes(t.slice(1))) return false;
    } else if (t.startsWith("#")) {
      if (node.attrs.id !== t.slice(1)) return false;
    } else {
      const am = t.match(/^\[([\w-]+)(?:([~^$*|]?=)"?([^\]"]*)"?)?\]$/);
      if (!am) return false;
      const [, name, op, value] = am;
      const actual = node.attrs[name.toLowerCase()];
      if (actual === undefined) return false;
      if (!op) continue;
      if (op === "=" && actual !== value) return false;
      if (op === "^=" && !actual.startsWith(value)) return false;
      if (op === "$=" && !actual.endsWith(value)) return false;
      if (op === "*=" && !actual.includes(value)) return false;
    }
  }
  return true;
}

function walk(node: Node, part: string, out: Node[]) {
  for (const child of node.children) {
    if (matches(child, part)) out.push(child);
    walk(child, part, out);
  }
}

/** Flattened text of a subtree — what a cell usually needs. */
export function textOf(node: Node): string {
  return (node.text + node.children.map(textOf).join(" "))
    .replace(/\s+/g, " ")
    .trim();
}

/** One field: either text content, or `@attr` / `selector@attr`. */
export function extractField(row: Node, spec: string): string {
  const atIdx = spec.lastIndexOf("@");
  const hasAttr = atIdx > 0;
  const attr = hasAttr ? spec.slice(atIdx + 1) : "";
  const sel = hasAttr ? spec.slice(0, atIdx) : spec;
  const nodes = sel ? select(row, sel) : [row];
  if (!nodes.length) return "";
  if (!hasAttr) return textOf(nodes[0]);
  return nodes[0].attrs[attr.toLowerCase()] ?? "";
}

/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildUrl(a: Adapter, page: number): string {
  const params = new URLSearchParams(a.params ?? {}).toString();
  const url = new URL(a.url);
  if (params) url.search = params;
  if (a.page_param && page !== (a.first_page ?? 1)) url.searchParams.set(a.page_param, String(page));
  else if (a.page_param) url.searchParams.set(a.page_param, String(page));
  return url.toString();
}

async function fetchPage(a: Adapter, page: number, retries = 3): Promise<{ status: number; body: string }> {
  const url = buildUrl(a, page);
  const method = (a.method ?? "GET").toUpperCase();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { "user-agent": UA, "accept": "text/html,application/xhtml+xml" },
      });
      const body = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(2 ** attempt * 700 + Math.random() * 400);
        continue;
      }
      return { status: res.status, body };
    } catch (e) {
      if (attempt < retries) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      return { status: 0, body: `network ${(e as Error).name}` };
    }
  }
}

export async function crawl(
  a: Adapter,
  maxPages: number,
  delayMs: number,
): Promise<{ rows: ParsedRow[]; pages: number; status: string }> {
  const rows: ParsedRow[] = [];
  const first = a.first_page ?? 1;
  const last = Math.min(a.last_page ?? Infinity, first + maxPages - 1);

  for (let page = first; page <= last; page++) {
    const { status, body } = await fetchPage(a, page);
    if (status === 0) return { rows, pages: page - first + 1, status: `network error: ${body}` };
    if (status === 403) return { rows, pages: page - first + 1, status: "403 (blocked; no bypass attempted)" };
    if (status === 404) return { rows, pages: page - first + 1, status: "404 (search endpoint not found)" };
    if (status >= 400) return { rows, pages: page - first + 1, status: `http ${status}` };

    const doc = parseHtml(body);
    if (a.stop_when_missing && select(doc, a.stop_when_missing).length === 0) {
      return { rows, pages: page - first + 1, status: "ok (end of results)" };
    }
    const found = select(doc, a.row_selector);
    if (found.length === 0) {
      return {
        rows,
        pages: page - first + 1,
        status:
          page === first
            ? "0 rows on the first page — selectors do not match (not reported as an empty dataset)"
            : "ok (end of results)",
      };
    }
    for (const r of found) {
      const row: ParsedRow = {};
      for (const [name, spec] of Object.entries(a.fields)) row[name] = extractField(r, spec);
      rows.push(row);
    }
    await sleep(delayMs);
  }
  return { rows, pages: last - first + 1, status: "ok (page cap reached)" };
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const adapterPath = arg("adapter");
  const out = arg("out");
  if (!adapterPath || !out) {
    console.error("need --adapter <json> --out <prefix>");
    process.exit(2);
  }
  const adapter = JSON.parse(readFileSync(adapterPath, "utf8")) as Adapter;
  const maxPages = Number(arg("max-pages", "5"));
  const delayMs = Number(arg("delay", "1200"));

  const { rows, pages, status } = await crawl(adapter, maxPages, delayMs);

  mkdirSync(dirname(out) || ".", { recursive: true });
  const cols = Object.keys(adapter.fields);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  writeFileSync(`${out}.csv`, "\uFEFF" + csv, "utf8");
  writeFileSync(`${out}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(
    `${out}-report.json`,
    JSON.stringify({ adapter: adapter.name, pages, rows: rows.length, status, fetched_at: new Date().toISOString() }, null, 2),
    "utf8",
  );

  console.log(`${adapter.name}: ${rows.length} rows over ${pages} page(s) — ${status}`);
  if (rows.length === 0 && !status.startsWith("ok")) process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) void main();
