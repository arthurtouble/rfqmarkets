// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IPriceOracle} from "../../contracts/interfaces/IPriceOracle.sol";
import {SignedPriceOracle} from "../../contracts/oracle/SignedPriceOracle.sol";
import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice The signed oracle returns a price only where a majority of independent nodes agree, and leaves a
/// market out (so it cannot trade) when they disagree or the price jumps.
contract SignedPriceOracleTest is ClearingFixture {
    SignedPriceOracle internal signed;
    uint256[3] internal nodeKeys = [uint256(0x0A1), 0x0B2, 0x0C3];
    address internal fakeClearing = makeAddr("clearing");
    uint64 internal t;

    function setUp() public override {
        super.setUp();
        address[] memory nodes = new address[](3);
        for (uint256 i; i < 3; ++i) {
            nodes[i] = vm.addr(nodeKeys[i]);
        }
        // 2 of 3, mids within 10 bps, batches within 5 s, jumps above 10% within 60 s rejected.
        signed = new SignedPriceOracle(governance, nodes, 2, 10, 5, 1_000, 60);
        vm.prank(governance);
        signed.setClearing(fakeClearing);
        t = uint64(vm.getBlockTimestamp());
    }

    // ---- Helpers ----

    function prices2(uint256 btcMid, uint256 ethMid) internal pure returns (SignedPriceOracle.Price[] memory p) {
        p = new SignedPriceOracle.Price[](2);
        p[0] = SignedPriceOracle.Price(0, btcMid - 5e6, btcMid + 5e6);
        p[1] = SignedPriceOracle.Price(1, ethMid - 1e6, ethMid + 1e6);
    }

    function batch(uint256 key, uint64 observedAt, SignedPriceOracle.Price[] memory p)
        internal
        view
        returns (SignedPriceOracle.SignedPriceBatch memory b)
    {
        b.observedAt = observedAt;
        b.prices = p;
        b.signature = signDigest(key, signed.batchDigest(observedAt, p));
    }

    function encode(SignedPriceOracle.SignedPriceBatch memory a, SignedPriceOracle.SignedPriceBatch memory b)
        internal
        pure
        returns (bytes memory)
    {
        SignedPriceOracle.SignedPriceBatch[] memory batches = new SignedPriceOracle.SignedPriceBatch[](2);
        batches[0] = a;
        batches[1] = b;
        return abi.encode(batches);
    }

    function verifyAsClearing(bytes memory reportBytes) internal returns (IPriceOracle.Observation[] memory) {
        vm.prank(fakeClearing);
        return signed.verify(reportBytes);
    }

    // ---- Tests ----

    function test_twoAgreeingSignersProduceTheMedian() public {
        bytes memory r = encode(
            batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6)), batch(nodeKeys[1], t, prices2(100_001e6, 4_000e6))
        );
        IPriceOracle.Observation[] memory o = verifyAsClearing(r);
        assertEq(o.length, 2);
        assertEq(uint256(o[0].market), 0);
        // Even count: mean of the two, bid rounded down and ask up.
        assertEq(o[0].bid, uint256(100_000e6 - 5e6 + 100_001e6 - 5e6) / 2);
        assertEq(o[0].ask, (uint256(100_000e6 + 5e6 + 100_001e6 + 5e6) + 1) / 2);
        assertEq(o[0].observedAt, t);
        assertEq(o[0].validUntil, t + 15);
        assertEq(o[1].bid, 3_999e6);
    }

    function test_threeSignersUseTheMiddleValue() public {
        SignedPriceOracle.SignedPriceBatch[] memory batches = new SignedPriceOracle.SignedPriceBatch[](3);
        batches[0] = batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6));
        batches[1] = batch(nodeKeys[1], t, prices2(100_050e6, 4_000e6));
        batches[2] = batch(nodeKeys[2], t, prices2(100_020e6, 4_000e6));
        IPriceOracle.Observation[] memory o = verifyAsClearing(abi.encode(batches));
        assertEq(o[0].bid, 100_020e6 - 5e6);
        assertEq(o[0].ask, 100_020e6 + 5e6);
    }

    function test_oneSignerIsNotEnough() public {
        SignedPriceOracle.SignedPriceBatch[] memory batches = new SignedPriceOracle.SignedPriceBatch[](1);
        batches[0] = batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6));
        vm.prank(fakeClearing);
        vm.expectRevert(SignedPriceOracle.InvalidReport.selector);
        signed.verify(abi.encode(batches));
    }

    function test_theSameSignerTwiceIsNotTwoSigners() public {
        bytes memory r = encode(
            batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6)), batch(nodeKeys[0], t, prices2(100_001e6, 4_000e6))
        );
        vm.prank(fakeClearing);
        vm.expectRevert(SignedPriceOracle.InvalidReport.selector);
        signed.verify(r);
    }

    function test_unknownSignerIsRejected() public {
        bytes memory r =
            encode(batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6)), batch(0xBAD, t, prices2(100_000e6, 4_000e6)));
        vm.prank(fakeClearing);
        vm.expectRevert(SignedPriceOracle.Unauthorized.selector);
        signed.verify(r);
    }

    function test_tamperedPriceBreaksTheSignature() public {
        SignedPriceOracle.SignedPriceBatch memory a = batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6));
        SignedPriceOracle.SignedPriceBatch memory b = batch(nodeKeys[1], t, prices2(100_000e6, 4_000e6));
        b.prices[0].bid = 90_000e6; // recovers to some other address
        vm.prank(fakeClearing);
        vm.expectRevert(SignedPriceOracle.Unauthorized.selector);
        signed.verify(encode(a, b));
    }

    function test_onlyTheClearingHouseMayVerify() public {
        bytes memory r = encode(
            batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6)), batch(nodeKeys[1], t, prices2(100_000e6, 4_000e6))
        );
        vm.expectRevert(SignedPriceOracle.Unauthorized.selector);
        signed.verify(r);
    }

    function test_disagreeingSignersLeaveTheMarketOut() public {
        // BTC mids 30 bps apart (> 10 bps), ETH identical.
        bytes memory r = encode(
            batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6)), batch(nodeKeys[1], t, prices2(100_300e6, 4_000e6))
        );
        IPriceOracle.Observation[] memory o = verifyAsClearing(r);
        assertEq(o.length, 1);
        assertEq(uint256(o[0].market), 1);
    }

    function test_marketSignedByTooFewNodesIsLeftOut() public {
        SignedPriceOracle.Price[] memory btcOnly = new SignedPriceOracle.Price[](1);
        btcOnly[0] = SignedPriceOracle.Price(0, 99_995e6, 100_005e6);
        bytes memory r = encode(batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6)), batch(nodeKeys[1], t, btcOnly));
        IPriceOracle.Observation[] memory o = verifyAsClearing(r);
        assertEq(o.length, 1);
        assertEq(uint256(o[0].market), 0);
    }

    function test_batchesTooFarApartAreRejected() public {
        bytes memory r = encode(
            batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6)), batch(nodeKeys[1], t - 6, prices2(100_000e6, 4_000e6))
        );
        vm.prank(fakeClearing);
        vm.expectRevert(SignedPriceOracle.InvalidReport.selector);
        signed.verify(r);
    }

    function test_futureBatchesAreRejected() public {
        bytes memory r = encode(
            batch(nodeKeys[0], t + 1, prices2(100_000e6, 4_000e6)),
            batch(nodeKeys[1], t + 1, prices2(100_000e6, 4_000e6))
        );
        vm.prank(fakeClearing);
        vm.expectRevert(SignedPriceOracle.InvalidReport.selector);
        signed.verify(r);
    }

    function test_unsortedPricesAreRejected() public {
        SignedPriceOracle.Price[] memory p = prices2(100_000e6, 4_000e6);
        (p[0], p[1]) = (p[1], p[0]);
        bytes memory r = encode(batch(nodeKeys[0], t, p), batch(nodeKeys[1], t, p));
        vm.prank(fakeClearing);
        vm.expectRevert(SignedPriceOracle.InvalidReport.selector);
        signed.verify(r);
    }

    function test_jumpGuardPausesAMarketUntilTheWindowPasses() public {
        verifyAsClearing(
            encode(
                batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6)),
                batch(nodeKeys[1], t, prices2(100_000e6, 4_000e6))
            )
        );
        vm.warp(t + 10);
        // BTC +15% ten seconds later: left out. ETH moves 1% and is fine.
        IPriceOracle.Observation[] memory o = verifyAsClearing(
            encode(
                batch(nodeKeys[0], t + 10, prices2(115_000e6, 4_040e6)),
                batch(nodeKeys[1], t + 10, prices2(115_000e6, 4_040e6))
            )
        );
        assertEq(o.length, 1);
        assertEq(uint256(o[0].market), 1);
        assertEq(signed.lastMid(0), 100_000e6);

        // After the window the new level is accepted and becomes the reference.
        vm.warp(t + 61);
        o = verifyAsClearing(
            encode(
                batch(nodeKeys[0], t + 61, prices2(115_000e6, 4_040e6)),
                batch(nodeKeys[1], t + 61, prices2(115_000e6, 4_040e6))
            )
        );
        assertEq(o.length, 2);
        assertEq(signed.lastMid(0), 115_000e6);
    }

    function test_perMarketJumpLimitOverridesTheDefault() public {
        vm.prank(governance);
        signed.setMarketJumpLimit(0, 100); // 1%
        verifyAsClearing(
            encode(
                batch(nodeKeys[0], t, prices2(100_000e6, 4_000e6)),
                batch(nodeKeys[1], t, prices2(100_000e6, 4_000e6))
            )
        );
        vm.warp(t + 1);
        IPriceOracle.Observation[] memory o = verifyAsClearing(
            encode(
                batch(nodeKeys[0], t + 1, prices2(102_000e6, 4_000e6)),
                batch(nodeKeys[1], t + 1, prices2(102_000e6, 4_000e6))
            )
        );
        assertEq(o.length, 1);
        assertEq(uint256(o[0].market), 1);
    }

    function test_signerSetNeedsAMajorityThreshold() public {
        address[] memory nodes = new address[](4);
        for (uint256 i; i < 4; ++i) {
            nodes[i] = vm.addr(i + 1);
        }
        vm.startPrank(governance);
        vm.expectRevert(SignedPriceOracle.InvalidConfiguration.selector);
        signed.setSigners(nodes, 2); // 2 of 4 is not a majority
        signed.setSigners(nodes, 3);
        vm.stopPrank();
        assertEq(signed.threshold(), 3);
        assertFalse(signed.isSigner(vm.addr(nodeKeys[0])));
        assertTrue(signed.isSigner(nodes[3]));

        vm.prank(emergency);
        vm.expectRevert();
        signed.setSigners(nodes, 4);
    }

    function test_clearingTradesOnSignedPrices() public {
        vm.startPrank(governance);
        signed.setClearing(address(clearing));
        clearing.setOracle(address(signed));
        vm.stopPrank();
        fundMaker(FLOOR);
        openVenue();
        Trader memory alice = newTrader("alice", 10_000e6);

        bytes memory proof = encode(
            batch(nodeKeys[1], t, prices2(100_000e6, 4_000e6)), batch(nodeKeys[2], t, prices2(100_000e6, 4_000e6))
        );
        clearing.refreshOracle(proof);
        (,,, uint64 lastPriceTime, uint256 lastBid, uint256 lastAsk,) = clearing.markets(0);
        assertEq(lastPriceTime, t);
        assertEq(lastBid, 99_995e6);
        assertEq(lastAsk, 100_005e6);

        (TradeIntent memory intent, MakerApproval memory approval,) = quote(alice.account, 0, 1e16, false);
        approval.oracleReportHash = keccak256(proof);
        // Pay the ask plus a margin for the impact charge.
        intent.limitPrice = 100_100e6;
        approval.executionPrice = 100_100e6;
        approval.intentHash = intentDigest(intent);
        execute(alice, intent, approval, proof);
        assertEq(clearing.positionOf(alice.account, 0).size, 1e16);
    }

    /// @dev Same vector as packages/shared/src/signed-oracle.test.ts, so node signatures and the adapter agree.
    function test_digestMatchesTheOracleNodeVector() public {
        vm.chainId(8453);
        address[] memory one = new address[](1);
        one[0] = address(1);
        deployCodeTo(
            "SignedPriceOracle.sol:SignedPriceOracle",
            abi.encode(governance, one, uint8(1), uint16(10), uint64(5), uint16(0), uint64(0)),
            address(0xdEaD)
        );
        SignedPriceOracle.Price[] memory p = new SignedPriceOracle.Price[](2);
        p[0] = SignedPriceOracle.Price(0, 60_000_000_000, 60_010_000_000);
        p[1] = SignedPriceOracle.Price(1, 3_000_000_000, 3_001_000_000);
        assertEq(
            SignedPriceOracle(address(0xdEaD)).batchDigest(1_700_000_000, p),
            0xfa5f674f239e7f1ef584d02a4a987a5af9bfd307847fd9a50276624f4707f4be
        );
    }
}
