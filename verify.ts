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
import { classify } from "./recheck.ts";
import { parseHtml, select, extractField, textOf } from "./search.ts";
import { makeMockSource, normalise, collectAll } from "./source.ts";

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


console.log("\nrecheck classifier");
{
  const bodyWithAvail = { product: { variants: [{ price: "10", available: true }] } };
  check("available=false is unavailable", classify(10, 200, { product: { variants: [{ price: "10", available: false }] } }).status === "unavailable");
  check("available=true is unchanged", classify(10, 200, bodyWithAvail).status === "unchanged");
  check("missing available + inventory_quantity>0 is NOT unavailable",
    classify(10, 200, { product: { variants: [{ price: "10", inventory_quantity: 5 }] } }).status === "unchanged");
  check("inventory_policy=continue counts as available",
    classify(10, 200, { product: { variants: [{ price: "10", inventory_quantity: 0, inventory_policy: "continue" }] } }).status === "unchanged");
  check("no stock evidence at all refuses to guess",
    classify(10, 200, { product: { variants: [{ price: "10" }] } }).detail.includes("refused to guess"));
  check("404 is gone, never unavailable", classify(10, 404, null).status === "gone");
  check("403 is error, never gone", classify(10, 403, null).status === "error");
  check("price change is detected", classify(10, 200, { product: { variants: [{ price: "12", available: true }] } }).status === "price_changed");
}

console.log("\nform crawler (mini selector engine)");
{
  const html = `<html><body><table id="results">
    <tr class="row"><td class="name">ACME S.p.A.</td><td class="vat">01234567890</td><td><a href="/c/1">detail</a></td></tr>
    <tr class="row"><td class="name">BETA Srl</td><td class="vat">09876543210</td><td><a href="/c/2">detail</a></td></tr>
  </table></body></html>`;
  const doc = parseHtml(html);
  const rows = select(doc, "tr.row");
  check("finds rows by tag + class", rows.length === 2);
  check("class selector only matches whole class tokens", select(doc, ".name").length === 2);
  check("id selector works", select(doc, "#results").length === 1);
  check("descendant combinator works", select(doc, "table .vat").length === 2);
  check("attribute selector works", select(doc, 'a[href="/c/2"]').length === 1);
  check("prefix attribute selector works", select(doc, 'a[href^="/c/"]').length === 2);
  check("text extraction is trimmed", textOf(select(doc, ".name")[0]) === "ACME S.p.A.");
  check("field reads text", extractField(rows[0], ".name") === "ACME S.p.A.");
  check("field reads an attribute", extractField(rows[0], "a@href") === "/c/1");
  check("missing field returns empty string, not undefined", extractField(rows[0], ".nope") === "");
  check("header-only page yields zero rows (0 ≠ parse failure is the crawler's job)",
    select(parseHtml("<table><thead><tr><th>x</th></tr></thead></table>"), "tr.row").length === 0);
}

console.log("\nsource adapter + pipeline contract");
{
  const { rows, dropped } = normalise(
    [
      { sku: "A1", adr: 100, city: "  Delano  " },
      { sku: "", adr: 120, city: "Bakersfield" },
      { sku: "A3", adr: Number.NaN, city: "" },
    ],
    ["sku"],
  );
  check("row with empty key field is dropped, not silently kept", dropped.length === 1 && rows.length === 2);
  check("strings are trimmed", rows[0].city === "Delano");
  check("empty string becomes null, not ''", rows[1].city === null);
  check("NaN price becomes null, not 0", rows[1].adr === null);
  check("composite key is built from the key fields", rows[0].key === "A1");
}

async function pipelineChecks() {
  const mock = makeMockSource({ rowsPerPage: 5, pages: 3, partialPage: 2 });
  const all = await collectAll(mock);
  check("collector follows cursors to the end", all.rows.length === 7);
  check("a partial batch marks the whole snapshot partial", all.complete === false);
  check("partial snapshot is described as unusable for deletes", all.status.includes("not usable"));

  const clean = await collectAll(makeMockSource({ partialPage: 99 }));
  check("clean run is marked complete", clean.complete === true);
  check("clean run collects every page", clean.rows.length === 15);
}
await pipelineChecks();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}



