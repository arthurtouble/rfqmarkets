import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RESTRICTED_COUNTRIES, SANCTIONED_COUNTRIES, SANCTIONED_REGIONS, classifyLocation, locationAllows } from "./jurisdictions.mjs";

const policy = readFileSync(new URL("../../../apps/docs/content/legal/restricted-jurisdictions.md", import.meta.url), "utf8");
// Rows of the table under one "## heading": [code, name].
const table = (heading) => {
  const section = policy.split(/^## /m).find((part) => part.startsWith(heading)) ?? "";
  return [...section.matchAll(/^\| ([A-Z]{2}(?:-\d{2})?) \| (.+?) \|$/gm)].map((row) => [row[1], row[2]]);
};

test("the published policy lists exactly the jurisdictions the edge enforces", () => {
  const sanctioned = [
    ...Object.entries(SANCTIONED_COUNTRIES),
    ...Object.entries(SANCTIONED_REGIONS).flatMap(([country, regions]) => Object.entries(regions).map(([code, name]) => [`${country}-${code}`, name])),
  ];
  const published = table("Sanctioned jurisdictions");
  assert.deepEqual(published.map(([code]) => code).sort(), sanctioned.map(([code]) => code).sort());
  for (const [code, name] of sanctioned) assert.ok(published.find(([row]) => row === code)[1].startsWith(name), code);
  assert.deepEqual(Object.fromEntries(table("Restricted jurisdictions")), RESTRICTED_COUNTRIES);
});

test("no jurisdiction is in both tiers", () => {
  for (const code of Object.keys(RESTRICTED_COUNTRIES)) assert.equal(SANCTIONED_COUNTRIES[code], undefined, code);
});

test("classifies by country, occupied region and unverifiable location", () => {
  assert.equal(classifyLocation({ country: "de" }).status, "allowed");
  assert.equal(classifyLocation({ country: "SG" }).status, "allowed");
  assert.equal(classifyLocation({ country: "KP" }).status, "sanctioned");
  assert.equal(classifyLocation({ country: "UA", regionCode: "40" }).reason, "Sevastopol region");
  assert.equal(classifyLocation({ country: "UA" }).status, "allowed");
  assert.equal(classifyLocation({ country: "PR" }).status, "restricted");
  for (const cf of [undefined, null, {}, { country: "" }, { country: 7 }, { country: "T1" }, { country: "XX" }])
    assert.deepEqual([classifyLocation(cf).status, classifyLocation(cf).reason], ["restricted", "location_unverified"]);
});

test("restricted locations keep only exit paths for writes and every read", () => {
  const restricted = classifyLocation({ country: "US" });
  assert.equal(locationAllows(restricted, "/v1/risk", "GET"), true);
  assert.equal(locationAllows(restricted, "/v1/quote", "POST"), false);
  assert.equal(locationAllows(restricted, "/v1/orders", "POST"), false);
  assert.equal(locationAllows(restricted, "/v1/withdraw/execute", "POST"), true);
  assert.equal(locationAllows(restricted, "/v1/orders/x/cancel", "POST"), true);
  assert.equal(locationAllows(restricted, "/v1/close/all/quote", "POST"), true);
  assert.equal(locationAllows(classifyLocation({ country: "CU" }), "/v1/risk", "GET"), false);
  assert.equal(locationAllows(classifyLocation({ country: "JP" }), "/v1/quote", "POST"), true);
});
