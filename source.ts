/**
 * source.ts — the shape a client's own data source has to take.
 *
 * This file exists because "we can integrate your licensed data" is a sentence
 * until there is an interface. A client who owns STR, CoStar, RSMeans, Apollo or
 * an internal database does not want to hear about our scraper; they want to know
 * what they have to hand over. The answer is: any function that returns rows.
 *
 * Design rules, learned the hard way elsewhere in this repo:
 *   1. A source returns a STATUS with its rows. 'partial' and 'error' are values,
 *      not exceptions — the pipeline must never mistake them for "no data".
 *   2. Rows are plain objects with stable keys. No nesting, no currency symbols.
 *   3. Paging is a cursor the source owns. The pipeline does not guess page numbers.
 *   4. The source never decides what "gone" means. That is the diff engine's job,
 *      because only it can see two snapshots.
 *
 * Two implementations ship here: a mock licensed provider (for demos and tests)
 * and the HTTP one that wraps search.ts. A real client adapter is usually 30 lines.
 */

export type SourceStatus = "ok" | "partial" | "error";

export interface Batch {
  rows: Record<string, unknown>[];
  /** Omit to end paging. */
  next?: string;
  status: SourceStatus;
  /** Human-readable reason, mandatory when status !== 'ok'. */
  note?: string;
}

export interface SourceAdapter {
  id: string;
  /** What the row keys mean, so the deliverable can carry a schema note. */
  fields: Record<string, string>;
  fetchBatch(cursor?: string): Promise<Batch>;
}

/* ------------------------------------------------------------------ *
 * A mock licensed provider. Deterministic, offline, and deliberately
 * imperfect: page 2 comes back partial, so the pipeline's honesty rules
 * are exercised on every demo run instead of only in a real incident.
 * ------------------------------------------------------------------ */

export interface MockOptions {
  rowsPerPage?: number;
  pages?: number;
  /** Page index (1-based) that returns 'partial', to simulate a vendor gap. */
  partialPage?: number;
}

export function makeMockSource(opts: MockOptions = {}): SourceAdapter {
  const rowsPerPage = opts.rowsPerPage ?? 5;
  const pages = opts.pages ?? 3;
  const partialPage = opts.partialPage ?? 2;

  return {
    id: "mock-licensed-provider",
    fields: {
      sku: "vendor product id",
      hotel: "property name",
      city: "market city",
      adr: "average daily rate, USD, numeric",
      occupancy: "0-1 fraction",
    },
    async fetchBatch(cursor?: string): Promise<Batch> {
      const page = Number(cursor ?? "1");
      if (page > pages) return { rows: [], status: "ok" };
      const start = (page - 1) * rowsPerPage;
      const rows = Array.from({ length: rowsPerPage }, (_, i) => {
        const n = start + i + 1;
        return {
          sku: `SKU-${String(n).padStart(4, "0")}`,
          hotel: `Property ${n}`,
          city: n % 2 ? "Delano" : "Bakersfield",
          adr: 120 + ((n * 7) % 40),
          occupancy: Number((0.55 + ((n * 3) % 20) / 100).toFixed(2)),
        };
      });
      if (page === partialPage) {
        // vendor answered, but only with part of the page: a status, not an exception
        return {
          rows: rows.slice(0, Math.max(1, Math.floor(rowsPerPage / 2))),
          status: "partial",
          note: `vendor returned ${Math.floor(rowsPerPage / 2)} of ${rowsPerPage} rows for page ${page}`,
        };
      }
      return { rows, status: "ok", next: page < pages ? String(page + 1) : undefined };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Normalisation: one place where vendor quirks are flattened.
 * Anything unparseable becomes null (and is reported), never a guess.
 * ------------------------------------------------------------------ */

export interface Normalised extends Record<string, unknown> {
  key: string;
}

export interface NormaliseReport {
  rows: Normalised[];
  dropped: { row: Record<string, unknown>; reason: string }[];
}

export function normalise(rows: Record<string, unknown>[], keyFields: string[]): NormaliseReport {
  const out: Normalised[] = [];
  const dropped: NormaliseReport["dropped"] = [];

  for (const r of rows) {
    const keyParts = keyFields.map((f) => String(r[f] ?? "").trim());
    if (keyParts.some((p) => p === "")) {
      dropped.push({ row: r, reason: `missing key field (${keyFields.join(" + ")})` });
      continue;
    }
    const clean: Normalised = { key: keyParts.join("|") };
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "number") {
        clean[k] = Number.isFinite(v) ? v : null;
      } else if (typeof v === "string") {
        const t = v.trim();
        clean[k] = t === "" ? null : t;
      } else {
        clean[k] = v ?? null;
      }
    }
    out.push(clean);
  }
  return { rows: out, dropped };
}

/** Collect every page, and report what the source admitted about itself. */
export async function collectAll(src: SourceAdapter, maxBatches = 50) {
  const rows: Record<string, unknown>[] = [];
  const notes: { batch: number; status: SourceStatus; rows: number; note?: string }[] = [];
  let cursor: string | undefined;
  let batches = 0;

  while (batches < maxBatches) {
    const b = await src.fetchBatch(cursor);
    batches++;
    notes.push({ batch: batches, status: b.status, rows: b.rows.length, note: b.note });
    rows.push(...b.rows);
    if (b.status === "error") break;
    if (!b.next) break;
    cursor = b.next;
  }
  const clean = notes.every((n) => n.status === "ok");
  return {
    rows,
    notes,
    complete: clean,
    status: clean ? "ok" : "partial — snapshot is not usable for delete/stop decisions",
  };
}
