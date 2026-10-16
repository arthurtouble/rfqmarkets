import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import {
  BASE_CHAIN_ID,
  LIFI_DIAMOND,
  NATIVE,
  bridgeStatus,
  checkRoute,
  formatDuration,
  formatRate,
  formatTokenAmount,
  holdingsFrom,
  parseTokenInput,
  quoteUrl,
  routeProblem,
  routeTarget,
  LIFI_FUNCTIONS,
  type LifiQuote,
  type RouteRequest,
} from "./bridge.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// LiFiDiamond entry points as LI.FI's quotes call them (Across V4 and Relay bridges, and a same-chain swap).
const lifiAbi = parseAbi([
  "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
  "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
  "struct AcrossV4Data { bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
  "struct RelayDepositoryData { bytes32 orderId; address depositorAddress; }",
  "function swapAndStartBridgeTokensViaAcrossV4(BridgeData _bridgeData, SwapData[] _swapData, AcrossV4Data _acrossData) payable",
  "function startBridgeTokensViaRelayDepository(BridgeData _bridgeData, RelayDepositoryData _relayData) payable",
  "function swapTokensMultipleV3NativeToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, SwapData[] _swapData) payable",
  "function transfer(address to, uint256 amount)",
]);
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const pad32 = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const bridgeData = (
  receiver: Address,
  overrides: { destinationChainId?: bigint; hasDestinationCall?: boolean } = {},
) => ({
  transactionId: `0x${"ab".repeat(32)}` as Hex,
  bridge: "across",
  integrator: "rfq-markets",
  referrer: "0x0000000000000000000000000000000000000000" as Address,
  sendingAssetId: USDC_ARB as Address,
  receiver,
  minAmount: 49_875_000n,
  destinationChainId: overrides.destinationChainId ?? BigInt(BASE_CHAIN_ID),
  hasSourceSwaps: true,
  hasDestinationCall: overrides.hasDestinationCall ?? false,
});
// The fee collection LI.FI runs as a source swap before bridging.
const feeSwap = {
  callTo: "0xbD6C7B0d2f68c2b7805d88388319cfB6EcB50eA9" as Address,
  approveTo: "0xbD6C7B0d2f68c2b7805d88388319cfB6EcB50eA9" as Address,
  sendingAssetId: USDC_ARB as Address,
  receivingAssetId: USDC_ARB as Address,
  fromAmount: 50_000_000n,
  callData: "0xeedd56e1" as Hex,
  requiresDeposit: true,
};
/** Across V4 bridge calldata paying `receiver` (BridgeData) and `acrossReceiver` (the facet's own field). */
const acrossCall = (receiver: Address, overrides?: Parameters<typeof bridgeData>[1]) =>
  encodeFunctionData({
    abi: lifiAbi,
    functionName: "swapAndStartBridgeTokensViaAcrossV4",
    args: [
      bridgeData(receiver, overrides),
      [feeSwap],
      {
        receiverAddress: pad32(receiver),
        refundAddress: pad32(ACCOUNT),
        sendingAssetId: pad32(USDC_ARB),
        receivingAssetId: pad32(USDC_BASE),
        outputAmount: 49_875_000n,
        outputAmountMultiplier: 10n ** 18n,
        exclusiveRelayer: ZERO32,
        quoteTimestamp: 1_760_000_000,
        fillDeadline: 1_760_003_600,
        exclusivityParameter: 0,
        message: "0x",
      },
    ],
  });

const request: RouteRequest = {
  fromChain: 42161,
  fromToken: USDC_ARB,
  fromAmount: 50_000_000n,
  account: ACCOUNT,
  toToken: USDC_BASE,
};
const quote = (): LifiQuote => ({
  tool: "across",
  toolDetails: { name: "Across" },
  action: {
    fromChainId: 42161,
    toChainId: BASE_CHAIN_ID,
    fromToken: { address: USDC_ARB },
    toToken: { address: USDC_BASE },
    fromAmount: "50000000",
    fromAddress: ACCOUNT,
    toAddress: ACCOUNT,
  },
  estimate: {
    approvalAddress: LIFI_DIAMOND,
    toAmount: "49875000",
    toAmountMin: "49625000",
    fromAmountUSD: "50.00",
    toAmountUSD: "49.87",
    executionDuration: 4,
    feeCosts: [{ name: "LIFI Fixed Fee", amountUSD: "0.125", included: true }],
    gasCosts: [{ amountUSD: "0.01" }],
  },
  transactionRequest: { to: LIFI_DIAMOND, data: acrossCall(ACCOUNT), value: "0x0", chainId: 42161 },
});

test("quotes deliver Base USDC to the user's own wallet with no destination call", () => {
  const url = new URL(quoteUrl(request));
  assert.equal(url.searchParams.get("toChain"), "8453");
  assert.equal(url.searchParams.get("toToken"), USDC_BASE);
  assert.equal(url.searchParams.get("toAddress"), ACCOUNT);
  assert.equal(url.searchParams.get("fromAddress"), ACCOUNT);
  assert.equal(url.searchParams.get("allowDestinationCall"), "false");
});

test("a matching quote becomes a route with fees, gas, rate and arrival time", () => {
  const route = checkRoute(quote(), request, 6);
  assert.equal(route.toAmount, 49_875_000n);
  assert.equal(route.toAmountMin, 49_625_000n);
  assert.equal(route.tool, "Across");
  assert.equal(route.feesUsd, 0.125);
  assert.equal(route.gasUsd, 0.01);
  assert.equal(route.approval, LIFI_DIAMOND);
  assert.equal(route.transaction.value, 0n);
  assert.equal(formatRate(route, "USDC"), "1 USDC = 0.9975 USDC");
  assert.equal(formatDuration(route.durationSeconds), "about 5 sec");
  assert.equal(routeProblem(route, false, 10_000_000n), null);
});

test("refuses a quote that sends funds elsewhere or spends more", () => {
  const cases: Array<[string, (value: LifiQuote) => void]> = [
    [
      "recipient",
      (value) => {
        value.action!.toAddress = OTHER;
      },
    ],
    [
      "destination asset",
      (value) => {
        value.action!.toToken = { address: OTHER };
      },
    ],
    [
      "destination network",
      (value) => {
        value.action!.toChainId = 1;
      },
    ],
    [
      "source network",
      (value) => {
        value.transactionRequest!.chainId = 1;
      },
    ],
    [
      "amount",
      (value) => {
        value.action!.fromAmount = "50000001";
      },
    ],
    [
      "router",
      (value) => {
        value.transactionRequest!.to = OTHER;
      },
    ],
    [
      "approval",
      (value) => {
        value.estimate!.approvalAddress = OTHER;
      },
    ],
    [
      "value",
      (value) => {
        value.transactionRequest!.value = "0x1";
      },
    ],
    [
      "output",
      (value) => {
        value.estimate!.toAmountMin = "49875001";
      },
    ],
  ];
  for (const [why, change] of cases) {
    const value = quote();
    change(value);
    assert.throws(() => checkRoute(value, request, 6), new RegExp(why), why);
  }
});

test("a native-asset route must send exactly the amount as value", () => {
  const native: RouteRequest = { ...request, fromToken: NATIVE, fromAmount: 10n ** 16n };
  const value = quote();
  value.action!.fromToken = { address: NATIVE };
  value.action!.fromAmount = String(10n ** 16n);
  value.transactionRequest!.value = `0x${(10n ** 16n).toString(16)}`;
  const route = checkRoute(value, native, 18);
  assert.equal(route.approval, null);
  assert.equal(route.transaction.value, 10n ** 16n);
  value.transactionRequest!.value = "0x0";
  assert.throws(() => checkRoute(value, native, 18), /value/);
});

test("routes that lose too much or miss the first-deposit floor are refused", () => {
  const costly = quote();
  costly.estimate!.toAmountUSD = "45";
  assert.match(routeProblem(checkRoute(costly, request, 6), false, 10_000_000n) ?? "", /Fees/);
  const small = quote();
  small.estimate!.toAmountMin = "9000000";
  assert.match(routeProblem(checkRoute(small, request, 6), true, 10_000_000n) ?? "", /First deposit/);
});

test("holdings keep verified assets on supported networks, most valuable first, without Base USDC", () => {
  const holdings = holdingsFrom(
    {
      balances: {
        "42161": [
          {
            address: NATIVE,
            symbol: "ETH",
            decimals: 18,
            amount: String(10n ** 17n),
            priceUSD: "2500",
            verificationStatus: "verified",
          },
          {
            address: USDC_ARB,
            symbol: "USDC",
            decimals: 6,
            amount: "20000000",
            priceUSD: "1",
            verificationStatus: "verified",
          },
          {
            address: OTHER,
            symbol: "SCAM",
            decimals: 18,
            amount: String(10n ** 24n),
            priceUSD: "1",
            verificationStatus: "unverified",
          },
        ],
        "8453": [
          {
            address: USDC_BASE,
            symbol: "USDC",
            decimals: 6,
            amount: "5000000",
            priceUSD: "1",
            verificationStatus: "verified",
          },
          {
            address: NATIVE,
            symbol: "ETH",
            decimals: 18,
            amount: "1000",
            priceUSD: "2500",
            verificationStatus: "verified",
          },
        ],
        "250": [{ address: NATIVE, symbol: "FTM", decimals: 18, amount: String(10n ** 21n), priceUSD: "1" }],
      },
    },
    USDC_BASE,
  );
  assert.deepEqual(
    holdings.map((holding) => `${holding.chainId}:${holding.symbol}`),
    ["42161:ETH", "42161:USDC"],
  );
  assert.deepEqual(holdingsFrom(null, USDC_BASE), []);
});

test("bridge status reports delivery of Base USDC, other outcomes and failure", () => {
  assert.deepEqual(bridgeStatus({ status: "PENDING" }, USDC_BASE), { state: "pending", detail: undefined });
  assert.deepEqual(
    bridgeStatus(
      {
        status: "DONE",
        substatus: "COMPLETED",
        receiving: { amount: "49900000", chainId: 8453, token: { address: USDC_BASE, chainId: 8453 } },
      },
      USDC_BASE,
    ),
    { state: "done", received: 49_900_000n },
  );
  assert.equal(
    bridgeStatus(
      {
        status: "DONE",
        substatus: "PARTIAL",
        receiving: { token: { address: OTHER, symbol: "USDbC", chainId: 8453 } },
      },
      USDC_BASE,
    ).state,
    "other",
  );
  assert.equal(bridgeStatus({ status: "DONE", substatus: "REFUNDED" }, USDC_BASE).state, "other");
  assert.equal(bridgeStatus({ status: "FAILED" }, USDC_BASE).state, "failed");
});

test("token amounts parse and format in the token's own decimals", () => {
  assert.equal(parseTokenInput("0.05", 18), 5n * 10n ** 16n);
  assert.equal(parseTokenInput("1.1234567", 6), null);
  assert.equal(parseTokenInput("0", 6), null);
  assert.equal(parseTokenInput("", 6), null);
  assert.equal(formatTokenAmount(1_234_567_891n, 6, 4), "1,234.5678");
  assert.equal(formatTokenAmount(10n ** 18n, 18), "1");
  assert.equal(formatDuration(1_080), "about 18 min");
});

test("the router's calldata must pay the user's own wallet on Base", () => {
  assert.deepEqual(routeTarget(acrossCall(ACCOUNT)), {
    receiver: ACCOUNT,
    destinationChainId: BigInt(BASE_CHAIN_ID),
    destinationCall: false,
  });
  // LI.FI's summary can say one thing while the calldata pays someone else.
  const diverted = quote();
  diverted.transactionRequest!.data = acrossCall(OTHER);
  assert.throws(() => checkRoute(diverted, request, 6), /recipient in calldata/);
  const elsewhere = quote();
  elsewhere.transactionRequest!.data = acrossCall(ACCOUNT, { destinationChainId: 1n });
  assert.throws(() => checkRoute(elsewhere, request, 6), /destination network in calldata/);
  const withCall = quote();
  withCall.transactionRequest!.data = acrossCall(ACCOUNT, { hasDestinationCall: true });
  assert.throws(() => checkRoute(withCall, request, 6), /destination call/);
});

test("bridge calls without a source swap are read the same way", () => {
  const data = encodeFunctionData({
    abi: lifiAbi,
    functionName: "startBridgeTokensViaRelayDepository",
    args: [bridgeData(ACCOUNT), { orderId: `0x${"cd".repeat(32)}`, depositorAddress: ACCOUNT }],
  });
  assert.equal(routeTarget(data).receiver, ACCOUNT);
  const value = quote();
  value.transactionRequest!.data = data;
  assert.equal(checkRoute(value, request, 6).transaction.data, data);
});

test("a same-chain swap on Base must pay the user and name no destination chain", () => {
  const swap = (receiver: Address) =>
    encodeFunctionData({
      abi: lifiAbi,
      functionName: "swapTokensMultipleV3NativeToERC20",
      args: [
        `0x${"ef".repeat(32)}`,
        "rfq-markets",
        "",
        receiver,
        24_800_000n,
        [{ ...feeSwap, sendingAssetId: NATIVE, receivingAssetId: USDC_BASE, fromAmount: 10n ** 16n }],
      ],
    });
  const onBase: RouteRequest = {
    ...request,
    fromChain: BASE_CHAIN_ID,
    fromToken: NATIVE,
    fromAmount: 10n ** 16n,
  };
  const value = quote();
  value.action = {
    ...value.action!,
    fromChainId: BASE_CHAIN_ID,
    fromToken: { address: NATIVE },
    fromAmount: String(10n ** 16n),
  };
  value.transactionRequest = {
    to: LIFI_DIAMOND,
    data: swap(ACCOUNT),
    value: `0x${(10n ** 16n).toString(16)}`,
    chainId: BASE_CHAIN_ID,
  };
  assert.equal(checkRoute(value, onBase, 18).transaction.data, swap(ACCOUNT));
  value.transactionRequest.data = swap(OTHER);
  assert.throws(() => checkRoute(value, onBase, 18), /recipient in calldata/);
  // A swap's calldata can't stand in for a cross-chain deposit.
  const crossChain = quote();
  crossChain.transactionRequest!.data = swap(ACCOUNT);
  assert.throws(() => checkRoute(crossChain, request, 6), /destination network in calldata/);
});

test("router calls the app cannot verify are refused", () => {
  for (const data of [
    encodeFunctionData({ abi: lifiAbi, functionName: "transfer", args: [ACCOUNT, 1n] }),
    "0xabcdef",
    "0x",
    `${acrossCall(ACCOUNT).slice(0, 200)}`,
  ]) {
    const value = quote();
    value.transactionRequest!.data = data;
    assert.throws(() => checkRoute(value, request, 6), /calldata/, data.slice(0, 10));
  }
});

test("the known selectors are the LiFiDiamond functions they claim to be", () => {
  assert.equal(
    LIFI_FUNCTIONS.get(
      toFunctionSelector(
        lifiAbi.find(
          (item) => item.type === "function" && item.name === "swapAndStartBridgeTokensViaAcrossV4",
        )!,
      ),
    )?.name,
    "swapAndStartBridgeTokensViaAcrossV4",
  );
  // Seen in live LI.FI quotes for deposits to Base.
  for (const [selector, name] of [
    ["0x1794958f", "swapAndStartBridgeTokensViaAcrossV4"],
    ["0xa3443faa", "swapAndStartBridgeTokensViaRelayDepository"],
    ["0x736eac0b", "swapTokensMultipleV3NativeToERC20"],
    ["0xa6010a66", "swapAndStartBridgeTokensViaStargate"],
    ["0x4f3b0759", "swapAndStartBridgeTokensViaCelerCircleBridge"],
  ] as const)
    assert.equal(LIFI_FUNCTIONS.get(selector)?.name, name);
});
