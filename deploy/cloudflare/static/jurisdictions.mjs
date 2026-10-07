// Where RFQ Markets may not be used, by IP location. apps/docs/content/legal/restricted-jurisdictions.md
// publishes the same lists and jurisdictions.test.mjs keeps the two in step, so change both together.
//
// Sanctioned: comprehensive sanctions or a ban on crypto-asset services to residents. Every venue service
// route is refused, reads included.
// Restricted: derivatives on this venue are not offered to residents. Nothing that opens or adds risk is
// accepted, but closing, cancelling, withdrawing and revoking stay open so nobody's funds are trapped.
// A location that cannot be established (no geolocation, Tor, Cloudflare's "XX") is treated as restricted.

export const SANCTIONED_COUNTRIES = {
  AF: "Afghanistan",
  BY: "Belarus",
  CU: "Cuba",
  IR: "Iran",
  KP: "North Korea",
  MM: "Myanmar",
  RU: "Russia",
  SY: "Syria",
  VE: "Venezuela",
};

// Ukrainian regions under occupation, by ISO 3166-2 subdivision code (Cloudflare's request.cf.regionCode).
export const SANCTIONED_REGIONS = {
  UA: {
    "09": "Luhansk",
    "14": "Donetsk",
    "23": "Zaporizhzhia",
    "40": "Sevastopol",
    "43": "Crimea",
    "65": "Kherson",
  },
};

export const RESTRICTED_COUNTRIES = {
  AS: "American Samoa",
  CA: "Canada",
  CD: "Democratic Republic of the Congo",
  CF: "Central African Republic",
  GB: "United Kingdom",
  GU: "Guam",
  IQ: "Iraq",
  LB: "Lebanon",
  LY: "Libya",
  ML: "Mali",
  MP: "Northern Mariana Islands",
  NI: "Nicaragua",
  PR: "Puerto Rico",
  SD: "Sudan",
  SO: "Somalia",
  SS: "South Sudan",
  UM: "United States Minor Outlying Islands",
  US: "United States",
  VI: "United States Virgin Islands",
  YE: "Yemen",
  ZW: "Zimbabwe",
};

// Cloudflare's codes for Tor exit nodes and for addresses it cannot place.
const UNVERIFIED = new Set(["T1", "XX"]);

/**
 * Classifies a request by Cloudflare's geolocation (request.cf). Only request.cf is trusted: it is set by
 * Cloudflare and cannot be supplied by the client, unlike a forwarded header.
 * @returns {{ status: "allowed" | "restricted" | "sanctioned", country: string | null, region: string | null, reason: string | null }}
 */
export function classifyLocation(cf) {
  const country = typeof cf?.country === "string" ? cf.country.toUpperCase() : null;
  const region = typeof cf?.regionCode === "string" ? cf.regionCode.toUpperCase() : null;
  if (!country || UNVERIFIED.has(country)) return { status: "restricted", country, region, reason: "location_unverified" };
  if (SANCTIONED_COUNTRIES[country]) return { status: "sanctioned", country, region, reason: SANCTIONED_COUNTRIES[country] };
  const regionName = region ? SANCTIONED_REGIONS[country]?.[region] : undefined;
  if (regionName) return { status: "sanctioned", country, region, reason: `${regionName} region` };
  if (RESTRICTED_COUNTRIES[country]) return { status: "restricted", country, region, reason: RESTRICTED_COUNTRIES[country] };
  return { status: "allowed", country, region, reason: null };
}

// Service writes that only reduce risk or move a trader's own money out. Restricted locations keep these.
// /v1/prepare and /v1/approve settle a quote; the only quotes a restricted location can get are close quotes.
const EXIT_WRITES = [
  /^\/v1\/(prepare|approve)$/,
  /^\/v1\/close\/(prepare|execute|quote)$/,
  /^\/v1\/close\/all\/quote$/,
  /^\/v1\/(withdraw|session)\/(prepare|execute)$/,
  /^\/v1\/nonce\/cancel\/(prepare|execute)$/,
  /^\/v1\/orders\/[A-Za-z0-9_-]{1,128}\/cancel(?:\/prepare)?$/,
];

/** Whether a service request from this location may proceed. Reads are only refused for sanctioned locations. */
export function locationAllows(location, pathname, method) {
  if (location.status === "allowed") return true;
  if (location.status === "sanctioned") return false;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  return EXIT_WRITES.some((pattern) => pattern.test(pathname));
}

export const RESTRICTION_MESSAGE = {
  sanctioned: "RFQ Markets is not available in your location.",
  restricted: "Opening or increasing positions is not available in your location. You can still close positions, cancel orders and withdraw.",
};
