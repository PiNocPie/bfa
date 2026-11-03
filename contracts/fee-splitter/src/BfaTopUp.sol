// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeTransfer} from "./SafeTransfer.sol";

/// @title BfaTopUp
/// @notice One per customer. Deployed by `BfaTopUpFactory` with CREATE2 (salt = customer wallet), so its
///         address is known before it exists and USDC can be sent to it first.
/// @dev    Every address it can ever pay is fixed in its bytecode at deployment: `wallet` (the customer) and
///         `feeRecipient` (BFA). It has no owner, no approve, no arbitrary call and no other token logic.
///         Only the factory may trigger a sweep, so every sweep emits the factory's `Swept` event.
///         Tokens other than `token` sent here cannot be moved by anyone.
contract BfaTopUp {
    using SafeTransfer for address;

    /// @dev Fee charged on top of the credited amount: credited + 1.5% = received,
    ///      so fee = received * 15 / 1015, rounded down (in the customer's favor).
    uint256 internal constant FEE_NUMERATOR = 15;
    uint256 internal constant FEE_DENOMINATOR = 1015;

    address public immutable factory;
    address public immutable token;
    address public immutable feeRecipient;
    address public immutable wallet;

    error OnlyFactory();

    constructor(address token_, address feeRecipient_, address wallet_) {
        factory = msg.sender;
        token = token_;
        feeRecipient = feeRecipient_;
        wallet = wallet_;
    }

    /// @notice Move this contract's whole `token` balance: the fee to `feeRecipient`, the rest to `wallet`.
    /// @return received the balance found here
    /// @return fee      the part sent to `feeRecipient`
    /// @return credited the part sent to `wallet`
    function sweep() external returns (uint256 received, uint256 fee, uint256 credited) {
        if (msg.sender != factory) revert OnlyFactory();
        received = token.balanceOf(address(this));
        fee = (received * FEE_NUMERATOR) / FEE_DENOMINATOR;
        credited = received - fee;
        if (fee != 0) token.safeTransfer(feeRecipient, fee);
        if (credited != 0) token.safeTransfer(wallet, credited);
    }
}
