// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Funding the maker cannot pay starts resolution, but only through a trade whose signatures hold.
/// A third party relaying an unsigned trade must not skip the maker's incident grace period.
contract UnsignedResolutionTest is ClearingFixture {
    // RFQClearingStorage.SLOT + the index of `makerBacking` in the namespace layout.
    bytes32 internal constant MAKER_BACKING_SLOT =
        bytes32(uint256(0x380d1b904479cc040b615065b149573a5f65fb6ce8d21382c296a05a0cc86d00) + 21);

    Trader internal alice;
    Trader internal bob;

    function setUp() public override {
        super.setUp();
        fundMaker(1_000_000e6);
        openVenue();
        alice = newTrader("alice", 50_000e6);
        bob = newTrader("bob", 200_000e6);
        refreshAll();
        // Customers are net long, so alice's short receives funding from the maker.
        trade(bob, 0, 2e18, false);
        trade(alice, 0, -1e17, false);
        vm.warp(block.timestamp + 3 days);
        refreshAll();
        // The maker can no longer pay what alice is owed.
        vm.store(address(clearing), MAKER_BACKING_SLOT, bytes32(uint256(1)));
        assertEq(clearing.makerBacking(), 1);
    }

    function test_unsignedTradeCannotStartResolution() public {
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            quote(alice.account, 0, -1e16, false);
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        bytes memory forged = sign(strangerKey, intent);
        bytes memory first = signApproval(approverKeys[0], approval);
        bytes memory second = signApproval(approverKeys[1], approval);
        vm.expectRevert(Unauthorized.selector);
        clearing.executeTrade(intent, approval, proof, forged, first, second);
        assertFalse(clearing.resolutionRequired());
    }

    function test_signedTradeStillStartsResolution() public {
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) =
            quote(alice.account, 0, -1e16, false);
        execute(alice, intent, approval, proof);
        assertTrue(clearing.resolutionRequired());
    }
}
