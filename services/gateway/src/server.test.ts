import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGateway } from "./server.js";

test("gateway reports upstream failure without blocking execution services",async()=>{const gateway=buildGateway({upstreamUrl:"http://upstream",fetchImpl:async()=>new Response("offline",{status:503}),reconnectMinMs:5,reconnectMaxMs:10});await gateway.ready();await new Promise(resolve=>setTimeout(resolve,20));const health=(await gateway.inject({method:"GET",url:"/health"})).json();assert.equal(health.ok,false);assert(health.reconnects>0);assert.match(health.lastError,/503/);await gateway.close();});
