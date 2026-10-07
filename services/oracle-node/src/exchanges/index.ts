import type { ExchangeName } from "../symbols.js";
import { binance } from "./binance.js";
import { bitstamp } from "./bitstamp.js";
import { bybit } from "./bybit.js";
import { coinbase } from "./coinbase.js";
import { gemini } from "./gemini.js";
import { kraken } from "./kraken.js";
import { okx } from "./okx.js";
import type { ExchangeAdapter } from "./types.js";

export const ADAPTERS: Record<ExchangeName, ExchangeAdapter> = {
  coinbase,
  kraken,
  bitstamp,
  gemini,
  okx,
  bybit,
  binance,
};
export type { ExchangeAdapter, QuoteUpdate, RestRequest } from "./types.js";
