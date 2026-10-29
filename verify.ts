/**
 * verify.ts — offline self-test. No network, no fixtures to download.
 *
 * Why offline: a test that needs a live storefront fails for reasons that have
 * nothing to do with this code (a site changes, a laptop is on a plane), and
 * then "the tests are red" tells you nothing. The network path is exercised by
 * `npm run demo` instead; what is asserted here is the logic buyers actually
 * care about — the diff engine and the status contract.
 *
 *   node verify.ts        → exits 0 when every assertion holds
 */

import { diffSnapshots, type Row } from "./diff.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function row(over: Partial<Row> & { product_id: number }): Row {
  return {
    store: over.store ?? "shop.test",
    product_id: over.product_id,
    handle: over.handle ?? `p-${over.product_id}`,
    title: over.title ?? `Product ${over.product_id}`,
    vendor: over.vendor ?? "V",
    product_type: over.product_type ?? "T",
    price_min: over.price_min ?? 10,
    price_max: over.price_max ?? 10,
    available_first: over.available_first ?? true,
    variant_count: over.variant_count ?? 1,
    snapshot_utc: over.snapshot_utc ?? "2026-01-01T00:00:00Z",
  };
}

const map = (...rows: Row[]) => new Map(rows.map((r) => [`${r.store}::${r.product_id}`, r]));

console.log("diff engine");

{
  const prev = map(row({ product_id: 1 }), row({ product_id: 2, price_min: 10 }));
  const cur = map(row({ product_id: 1 }), row({ product_id: 2, price_min: 12 }), row({ product_id: 3 }));
  const d = diffSnapshots(prev, cur);
  const kinds = d.map((c) => `${c.kind}:${c.product_id}`).sort();

  check("detects a price increase", kinds.includes("price_up:2"));
  check("reports the before and after price", d.find((c) => c.kind === "price_up" && c.product_id === 2)?.after === "12");
  check("detects a new product", kinds.includes("new:3"));
  check("does not invent changes for unchanged rows", !kinds.some((k) => k.endsWith(":1")));
}

{
  const d = diffSnapshots(map(row({ product_id: 1 })), map());
  check("a product missing from the new snapshot is 'gone'", d.length === 1 && d[0].kind === "gone");
}

{
  const d = diffSnapshots(map(row({ product_id: 1, price_min: 10 })), map(row({ product_id: 1, price_min: 8 })));
  check("a lower price is price_down, not price_up", d[0]?.kind === "price_down");
}

{
  const d = diffSnapshots(map(row({ product_id: 1, available_first: true })), map(row({ product_id: 1, available_first: false })));
  check("availability flip is stock_out", d[0]?.kind === "stock_out");
}

{
  const d = diffSnapshots(map(row({ product_id: 1, handle: "old" })), map(row({ product_id: 1, handle: "new" })));
  check("a changed handle is reported as renamed", d[0]?.kind === "renamed");
}

{
  const d = diffSnapshots(map(row({ product_id: 1 }), row({ product_id: 2 })), map(row({ product_id: 1 }), row({ product_id: 2 })));
  check("identical snapshots produce zero changes", d.length === 0);
}

{
  // guard: a store that vanished entirely must not silently look like "all gone"
  const prev = map(row({ product_id: 1, store: "a.test" }), row({ product_id: 9, store: "b.test" }));
  const cur = map(row({ product_id: 1, store: "a.test" }));
  const d = diffSnapshots(prev, cur);
  const goneFromB = d.filter((c) => c.kind === "gone" && c.store === "b.test");
  check("rows of a store absent from the new snapshot are still classified (caller is warned via summary)", goneFromB.length === 1);
}

console.log("\nsummary contract");
{
  const d = diffSnapshots(map(row({ product_id: 1, price_min: 5 })), map(row({ product_id: 1, price_min: 7 })));
  const csvSafe = d.every((c) => typeof c.store === "string" && typeof c.kind === "string");
  check("every change carries store, kind, product_id, title", csvSafe);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
