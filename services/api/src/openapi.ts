import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";
import { API_ERROR_CODES } from "../../../packages/shared/src/api-errors.js";
import { quoteRequestSchema } from "../../../packages/shared/src/policy.js";
import { ladderQuerySchema } from "./ladder.js";
import {
  approvalRequestSchema,
  cancelExecuteSchema,
  cancelPrepareSchema,
  closeAllQuoteSchema,
  closeExecuteSchema,
  closePrepareSchema,
  closeQuoteSchema,
  depositExecuteSchema,
  depositPrepareSchema,
  intentRequestSchema,
  isolatedMarginExecuteSchema,
  isolatedMarginPrepareSchema,
  orderPlaceSchema,
  orderPrepareSchema,
  sessionExecuteSchema,
  sessionPrepareSchema,
  sessionRevokeExecuteSchema,
  sessionRevokePrepareSchema,
  tpslPrepareSchema,
  triggerOrderPrepareSchema,
  withdrawalExecuteSchema,
  withdrawalPrepareSchema,
} from "./schemas.js";

type JsonSchema = Record<string, unknown>;

/**
 * The JSON Schema for a request schema. Covers the zod kinds the API's schemas use and throws on any other, so a
 * new kind fails the OpenAPI test rather than publishing a loose schema. Refinements (known market, valid
 * address) can't be expressed and are checked by the API at request time.
 */
export function jsonSchema(schema: ZodType): JsonSchema {
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string },
    checks = (
      (def.checks ?? []) as Array<{ _zod: { def: Record<string, unknown> & { check: string } } }>
    ).map((check) => check._zod.def);
  switch (def.type) {
    case "string": {
      const out: JsonSchema = { type: "string" };
      // A format schema (z.uuid(), z.email()) carries its format on the schema itself.
      if (def.format === "uuid") out.format = "uuid";
      else if (def.format !== undefined) throw new Error(`unsupported string check: ${String(def.format)}`);
      for (const check of checks) {
        if (check.check === "custom") continue;
        const format = check.check === "string_format" ? (check.format as string) : check.check;
        if (format === "regex") out.pattern = (check.pattern as RegExp).source;
        else if (format === "uuid") out.format = "uuid";
        else throw new Error(`unsupported string check: ${format}`);
      }
      return out;
    }
    case "number": {
      const out: JsonSchema = { type: "number" };
      for (const check of checks) {
        if (check.check === "custom") continue;
        if (check.check === "number_format") out.type = "integer";
        else if (check.check === "greater_than")
          out[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
        else if (check.check === "less_than")
          out[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
        else throw new Error(`unsupported number check: ${check.check}`);
      }
      return out;
    }
    case "boolean":
      return { type: "boolean" };
    case "enum":
      return { type: "string", enum: Object.values(def.entries as Record<string, string>) };
    case "literal": {
      const values = def.values as unknown[];
      return values.length === 1 ? { const: values[0] } : { enum: values };
    }
    case "optional":
    case "nullable":
      return jsonSchema(def.innerType as ZodType);
    case "default":
    case "prefault":
      return { ...jsonSchema(def.innerType as ZodType), default: def.defaultValue };
    case "pipe": {
      // A transform describes the input it reads; a preprocess, the schema it feeds.
      const input = def.in as ZodType;
      return jsonSchema(input._zod.def.type === "transform" ? (def.out as ZodType) : input);
    }
    case "union":
      return { anyOf: (def.options as ZodType[]).map(jsonSchema) };
    case "object": {
      const shape = def.shape as Record<string, ZodType>,
        properties: Record<string, JsonSchema> = {},
        required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = jsonSchema(field);
        if (field._zod.optin !== "optional") required.push(key);
      }
      return {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: true,
      };
    }
    default:
      throw new Error(`unsupported schema kind: ${def.type}`);
  }
}

type Operation = {
  method: "get" | "post";
  path: string;
  summary: string;
  tag: string;
  body?: ZodType;
  query?: ZodType;
  /** The shared wire type (packages/shared/src/api-types.ts) the response follows, when there is one. */
  response?: string;
};

/** Public routes. `/internal`, `/v1/dev` and the event stream are left out: they are not for integrators. */
export const OPERATIONS: Operation[] = [
  { method: "get", path: "/health", summary: "Service health", tag: "Status" },
  {
    method: "get",
    path: "/v1/config",
    summary: "Chain, contracts and per-market margin",
    tag: "Status",
    response: "ChainConfig",
  },
  {
    method: "get",
    path: "/v1/markets",
    summary: "Markets with live prices and limits",
    tag: "Markets",
    response: "MarketSnapshot",
  },
  {
    method: "get",
    path: "/v1/quote/ladder",
    summary: "Indicative prices at several sizes",
    tag: "Markets",
    query: ladderQuerySchema,
  },
  {
    method: "post",
    path: "/v1/quote",
    summary: "A firm quote for a market order",
    tag: "Trading",
    body: quoteRequestSchema,
    response: "Quote",
  },
  {
    method: "post",
    path: "/v1/close/quote",
    summary: "A firm quote that closes a position",
    tag: "Trading",
    body: closeQuoteSchema,
    response: "Quote",
  },
  {
    method: "post",
    path: "/v1/close/all/quote",
    summary: "Firm quotes that close every position",
    tag: "Trading",
    body: closeAllQuoteSchema,
  },
  {
    method: "post",
    path: "/v1/prepare",
    summary: "The typed data to sign for a quote",
    tag: "Trading",
    body: intentRequestSchema,
    response: "Prepared",
  },
  {
    method: "post",
    path: "/v1/approve",
    summary: "Submit a signed quote for approval and settlement",
    tag: "Trading",
    body: approvalRequestSchema,
  },
  {
    method: "get",
    path: "/v1/account/{address}",
    summary: "Balances and positions",
    tag: "Account",
    response: "AccountState",
  },
  {
    method: "post",
    path: "/v1/deposit/prepare",
    summary: "Gas-free USDC deposit: data to sign",
    tag: "Account",
    body: depositPrepareSchema,
  },
  {
    method: "post",
    path: "/v1/deposit/execute",
    summary: "Gas-free USDC deposit: submit",
    tag: "Account",
    body: depositExecuteSchema,
  },
  ...signedAction("/v1/withdraw", "Withdraw USDC", withdrawalPrepareSchema, withdrawalExecuteSchema),
  ...signedAction(
    "/v1/isolated/margin",
    "Move margin into or out of an isolated account",
    isolatedMarginPrepareSchema,
    isolatedMarginExecuteSchema,
  ),
  ...signedAction(
    "/v1/nonce/cancel",
    "Cancel every intent signed with a nonce",
    cancelPrepareSchema,
    cancelExecuteSchema,
  ),
  ...signedAction(
    "/v1/close",
    "Close a position at the oracle price, no worse than a signed limit",
    closePrepareSchema,
    closeExecuteSchema,
  ),
  ...signedAction(
    "/v1/session",
    "Grant a session key bounded trading authority",
    sessionPrepareSchema,
    sessionExecuteSchema,
  ),
  ...signedAction(
    "/v1/session/revoke",
    "Revoke a session key without gas",
    sessionRevokePrepareSchema,
    sessionRevokeExecuteSchema,
  ),
  {
    method: "post",
    path: "/v1/orders/prepare",
    summary: "A limit order: data to sign",
    tag: "Orders",
    body: orderPrepareSchema,
  },
  {
    method: "post",
    path: "/v1/orders/trigger/prepare",
    summary: "A stop-loss, take-profit or stop entry: data to sign",
    tag: "Orders",
    body: triggerOrderPrepareSchema,
    response: "PreparedTrigger",
  },
  {
    method: "post",
    path: "/v1/orders/tpsl/prepare",
    summary: "A take-profit and stop-loss pair: data to sign",
    tag: "Orders",
    body: tpslPrepareSchema,
    response: "PreparedTpsl",
  },
  {
    method: "post",
    path: "/v1/orders",
    summary: "Place a signed order",
    tag: "Orders",
    body: orderPlaceSchema,
  },
  {
    method: "get",
    path: "/v1/orders/{address}",
    summary: "An account's orders",
    tag: "Orders",
    response: "{ items: RestingOrder[] }",
  },
  {
    method: "post",
    path: "/v1/orders/{orderId}/cancel/prepare",
    summary: "Cancel an order: data to sign",
    tag: "Orders",
  },
  {
    method: "post",
    path: "/v1/orders/{orderId}/cancel",
    summary: "Cancel an order: submit",
    tag: "Orders",
    body: cancelExecuteSchema,
    response: "CancelResult",
  },
];

function signedAction(path: string, summary: string, prepare: ZodType, execute: ZodType): Operation[] {
  return [
    {
      method: "post",
      path: `${path}/prepare`,
      summary: `${summary}: data to sign`,
      tag: "Account",
      body: prepare,
    },
    { method: "post", path: `${path}/execute`, summary: `${summary}: submit`, tag: "Account", body: execute },
  ];
}

const errorSchema = {
  type: "object",
  required: ["error", "code", "retryable"],
  properties: {
    error: { type: "string", description: "A readable message. It may change; branch on `code`." },
    code: { type: "string", enum: [...API_ERROR_CODES] },
    retryable: {
      type: "boolean",
      description: "Whether the same request can succeed if sent again shortly.",
    },
  },
};

/** The OpenAPI 3.1 document for the public API, built from the same zod schemas that validate requests. */
export function openApiDocument(version = "1") {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of OPERATIONS) {
    const parameters = [
      ...[...operation.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      ...Object.entries(
        operation.query ? (jsonSchema(operation.query).properties as Record<string, JsonSchema>) : {},
      ).map(([name, schema]) => ({
        name,
        in: "query",
        required: ((jsonSchema(operation.query!).required as string[] | undefined) ?? []).includes(name),
        schema,
      })),
    ];
    paths[operation.path] ??= {};
    paths[operation.path][operation.method] = {
      summary: operation.summary,
      tags: [operation.tag],
      ...(parameters.length ? { parameters } : {}),
      ...(operation.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: jsonSchema(operation.body) } },
            },
          }
        : {}),
      responses: {
        "200": {
          description: operation.response
            ? `OK. The body follows \`${operation.response}\` in packages/shared/src/api-types.ts.`
            : "OK",
        },
        default: {
          description: "An error with a stable code",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "RFQ Markets API",
      version,
      description:
        "Amounts and prices are decimal strings in USDC; signed intents carry integer strings in micro-units. " +
        "Every error has a stable `code` and a `retryable` flag.",
    },
    paths,
    components: { schemas: { Error: errorSchema } },
  };
}

const registered = new WeakMap<FastifyInstance, Set<string>>();

/** Every route registered on `app` after `registerOpenApi`, as "method /path/{param}" (for the coverage test). */
export const registeredRoutes = (app: FastifyInstance) => registered.get(app) ?? new Set<string>();

/** Serves the document at GET /v1/openapi.json. Call it before the other routes so they are recorded. */
export function registerOpenApi(app: FastifyInstance) {
  const routes = new Set<string>();
  registered.set(app, routes);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat())
      if (method !== "HEAD" && method !== "OPTIONS")
        routes.add(`${method.toLowerCase()} ${route.url.replace(/:(\w+)/g, "{$1}")}`);
  });
  const document = openApiDocument();
  app.get("/v1/openapi.json", async () => document);
}
