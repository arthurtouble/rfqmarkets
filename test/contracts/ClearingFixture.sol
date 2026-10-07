// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {RFQClearing} from "../../contracts/RFQClearing.sol";
import {IPriceOracle} from "../../contracts/interfaces/IPriceOracle.sol";
import {RFQRiskMath} from "../../contracts/libraries/RFQRiskMath.sol";
import {MockPriceOracle} from "../../contracts/mocks/MockPriceOracle.sol";
import {MockUSDC} from "../../contracts/mocks/MockUSDC.sol";
import {TestProxy} from "../../contracts/test/TestProxy.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Deploys a clearing proxy over mocks and builds signed trades, the way the API and approvers do.
abstract contract ClearingFixture is Test {
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    uint256 internal constant FLOOR = 100_000e6;

    RFQClearing internal clearing;
    MockUSDC internal usdc;
    MockPriceOracle internal oracle;
    ProxyAdmin internal proxyAdmin;

    address internal governance = makeAddr("governance");
    address internal emergency = makeAddr("emergency");
    address internal maker = makeAddr("maker");
    address internal keeper = makeAddr("keeper");
    uint256[3] internal approverKeys = [uint256(0xA11CE), 0xB0B, 0xC0FFEE];
    address[3] internal approvers;

    /// @notice Fixture price per market id; `listMarket` appends one.
    uint256[] internal prices;
    uint256 internal nextNonce = 1;

    struct Trader {
        address account;
        uint256 key;
    }

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        delete prices;
        prices.push(100_000e6);
        prices.push(4_000e6);
        usdc = new MockUSDC();
        oracle = new MockPriceOracle();
        for (uint256 i; i < 3; ++i) {
            approvers[i] = vm.addr(approverKeys[i]);
        }
        clearing = deployClearing(pair(maxConfig(), maxConfig()));
    }

    /// @notice BTC (id 0) or ETH (id 1) at the absolute caps, with the launch risk parameters.
    function maxConfig() internal pure returns (MarketConfig memory) {
        return marketConfig("BTC", 10_000, 4_000);
    }

    function marketConfig(bytes32 symbol, uint32 impactK, uint16 shockBps) internal pure returns (MarketConfig memory) {
        return MarketConfig({
            symbol: symbol,
            enabled: true,
            maxTradeNotional: uint128(ABSOLUTE_MAX_TRADE_NOTIONAL),
            maxMarketNotional: uint128(ABSOLUTE_MAX_MARKET_NOTIONAL),
            grossLimit: uint128(ABSOLUTE_MAX_MARKET_NOTIONAL),
            sideLimit: uint128(ABSOLUTE_MAX_MARKET_NOTIONAL),
            impactK: impactK,
            shockBps: shockBps,
            marginScaleBps: 10_000
        });
    }

    /// @notice A BTC/ETH market pair: `btc` and `eth` keep their limits and get the launch symbols and risk.
    function pair(MarketConfig memory btc, MarketConfig memory eth) internal pure returns (MarketConfig[] memory configs) {
        btc.symbol = "BTC";
        btc.impactK = 10_000;
        btc.shockBps = 4_000;
        eth.symbol = "ETH";
        eth.impactK = 12_000;
        eth.shockBps = 5_000;
        configs = new MarketConfig[](2);
        configs[0] = btc;
        configs[1] = eth;
    }

    function deployClearing(MarketConfig[] memory configs) internal returns (RFQClearing deployed) {
        RFQClearing implementation = new RFQClearing();
        bytes memory init = abi.encodeCall(
            RFQClearing.initialize, (address(usdc), address(oracle), governance, emergency, approvers, FLOOR, configs)
        );
        TestProxy proxy = new TestProxy(address(implementation), governance, init);
        deployed = RFQClearing(address(proxy));
        proxyAdmin = ProxyAdmin(address(uint160(uint256(vm.load(address(proxy), ADMIN_SLOT)))));
    }

    // ---- Setup helpers ----

    function openVenue() internal {
        vm.prank(governance);
        clearing.unpause();
    }

    function fundMaker(uint256 amount) internal {
        usdc.mint(maker, amount);
        vm.startPrank(maker);
        usdc.approve(address(clearing), type(uint256).max);
        clearing.fundMaker(amount);
        vm.stopPrank();
    }

    function fundInsurance(uint256 amount) internal {
        usdc.mint(maker, amount);
        vm.startPrank(maker);
        usdc.approve(address(clearing), type(uint256).max);
        clearing.fundInsurance(amount);
        vm.stopPrank();
    }

    function newTrader(string memory name, uint256 deposit) internal returns (Trader memory trader) {
        (trader.account, trader.key) = makeAddrAndKey(name);
        if (deposit != 0) depositFor(trader.account, deposit);
    }

    function depositFor(address account, uint256 amount) internal {
        usdc.mint(account, amount);
        vm.startPrank(account);
        usdc.approve(address(clearing), type(uint256).max);
        clearing.deposit(amount);
        vm.stopPrank();
    }

    /// @notice Governance registers `config` as the next market, priced at `price`.
    function listMarket(MarketConfig memory config, uint256 price) internal returns (uint8 market) {
        vm.prank(governance);
        market = clearing.addMarket(config);
        assertEq(market, prices.length);
        prices.push(price);
    }

    // ---- Oracle helpers ----

    function report(uint8 market, uint256 price, uint256 observedAt) internal pure returns (bytes memory) {
        IPriceOracle.Observation[] memory observations = new IPriceOracle.Observation[](1);
        observations[0] = IPriceOracle.Observation(market, price, price, uint64(observedAt), uint64(observedAt + 60));
        return abi.encode(observations);
    }

    /// @notice A report pricing every market at the fixture prices, observed now. The oracle signs every
    /// market each round, so trades carry this.
    function currentReport(uint8) internal view returns (bytes memory) {
        uint256 now_ = vm.getBlockTimestamp();
        IPriceOracle.Observation[] memory observations = new IPriceOracle.Observation[](prices.length);
        for (uint256 i; i < prices.length; ++i) {
            observations[i] = IPriceOracle.Observation(uint8(i), prices[i], prices[i], uint64(now_), uint64(now_ + 60));
        }
        return abi.encode(observations);
    }

    function singleReport(uint8 market) internal view returns (bytes memory) {
        return report(market, prices[market], vm.getBlockTimestamp());
    }

    function refresh(uint8 market) internal {
        clearing.refreshOracle(singleReport(market));
    }

    function refreshAll() internal {
        refresh(0);
        refresh(1);
    }

    function setPrice(uint8 market, uint256 price) internal {
        prices[market] = price;
        refresh(market);
    }

    // ---- Trades ----

    /// @notice Builds and executes a fill at the oracle price plus exactly the required inventory-impact charge.
    function trade(Trader memory trader, uint8 market, int256 delta, bool reduceOnly) internal {
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            quote(trader.account, market, delta, reduceOnly);
        execute(trader, intent, approval, proof);
    }

    /// @notice Like `trade`, but expects the clearing contract to revert with `selector`.
    function tradeReverts(Trader memory trader, uint8 market, int256 delta, bytes4 selector) internal {
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            quote(trader.account, market, delta, false);
        bytes memory userSignature = sign(trader.key, intent);
        bytes memory first = signApproval(approverKeys[0], approval);
        bytes memory second = signApproval(approverKeys[1], approval);
        vm.expectRevert(selector);
        clearing.executeTrade(intent, approval, proof, userSignature, first, second);
    }

    function execute(Trader memory trader, TradeIntent memory intent, MakerApproval memory approval, bytes memory proof)
        internal
    {
        clearing.executeTrade(
            intent,
            approval,
            proof,
            sign(trader.key, intent),
            signApproval(approverKeys[0], approval),
            signApproval(approverKeys[1], approval)
        );
    }

    function quote(address account, uint8 market, int256 delta, bool reduceOnly)
        internal
        returns (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof)
    {
        proof = currentReport(market);
        (int256 aggregateBase,,,,,,) = clearing.markets(market);
        int256 skew = aggregateBase * int256(prices[market]) / 1e18;
        int256 impact = RFQRiskMath.impactCost(
            clearing.marketParams(market).impactK, skew, delta * int256(prices[market]) / 1e18
        );
        uint256 charge = impact > 0 ? uint256(impact) : 0;
        uint256 quantity = uint256(delta < 0 ? -delta : delta);
        uint256 premium = (charge * 1e18 + quantity - 1) / quantity;
        uint256 executionPrice = delta > 0 ? prices[market] + premium : prices[market] - premium;
        intent = TradeIntent({
            account: account,
            market: market,
            baseDelta: delta,
            limitPrice: executionPrice,
            maxFee: 0,
            nonce: nextNonce++,
            deadline: uint64(block.timestamp + 60),
            reduceOnly: reduceOnly
        });
        approval = MakerApproval({
            intentHash: intentDigest(intent),
            executionPrice: executionPrice,
            impactCharge: int256(charge),
            fee: 0,
            oracleReportHash: keccak256(proof),
            deadline: intent.deadline,
            leaderEpoch: clearing.leaderEpoch(),
            signerSetVersion: clearing.signerSetVersion(),
            policyVersion: clearing.policyVersion()
        });
    }

    // ---- EIP-712 ----

    function domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(clearing))
        );
    }

    function typedDigest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function intentDigest(TradeIntent memory intent) internal view returns (bytes32) {
        return typedDigest(
            keccak256(
                abi.encode(
                    TRADE_INTENT_TYPEHASH,
                    intent.account,
                    intent.market,
                    intent.baseDelta,
                    intent.limitPrice,
                    intent.maxFee,
                    intent.nonce,
                    intent.deadline,
                    intent.reduceOnly
                )
            )
        );
    }

    function approvalDigest(MakerApproval memory approval) internal view returns (bytes32) {
        return typedDigest(
            keccak256(
                abi.encode(
                    MAKER_APPROVAL_TYPEHASH,
                    approval.intentHash,
                    approval.executionPrice,
                    approval.impactCharge,
                    approval.fee,
                    approval.oracleReportHash,
                    approval.deadline,
                    approval.leaderEpoch,
                    approval.signerSetVersion,
                    approval.policyVersion
                )
            )
        );
    }

    function sign(uint256 key, TradeIntent memory intent) internal view returns (bytes memory) {
        return signDigest(key, intentDigest(intent));
    }

    function signApproval(uint256 key, MakerApproval memory approval) internal view returns (bytes memory) {
        return signDigest(key, approvalDigest(approval));
    }

    function signDigest(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ---- Accounting views ----

    function custodyMatchesBuckets() internal view returns (bool) {
        int256 buckets =
            int256(clearing.makerBacking()) + int256(clearing.insuranceBalance()) + clearing.totalCustomerCollateral();
        return buckets == int256(usdc.balanceOf(address(clearing)));
    }
}
