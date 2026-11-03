// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BfaTopUp} from "./BfaTopUp.sol";
import {SafeTransfer} from "./SafeTransfer.sol";

/// @title BfaTopUpFactory
/// @notice Non-custodial top-up router for BFA. Every customer wallet has a deterministic top-up address
///         (`topUpAddressOf`). Anyone can call `sweep(wallet)`, which deploys that address's contract if needed
///         and splits its whole token balance: BFA's 1.5% on-top fee to `feeRecipient`, the rest to `wallet`.
/// @dev    Immutable. No owner, no admin, no upgrade, no pause, no way to change the fee, the token, the fee
///         recipient or where a customer's money goes. Only `token` can be swept; any other token sent to a
///         top-up address is stuck there for good.
contract BfaTopUpFactory {
    using SafeTransfer for address;

    /// @notice Fee on top: to credit 10.00 the customer sends 10.15. fee = received * 15 / 1015 (rounded down).
    uint256 public constant FEE_NUMERATOR = 15;
    uint256 public constant FEE_DENOMINATOR = 1015;

    /// @notice Where the fee goes. Fixed at deployment.
    address public immutable feeRecipient;
    /// @notice The only token that can be swept (USDC). Fixed at deployment.
    address public immutable token;

    uint256 private _lock = 1;

    event TopUpDeployed(address indexed wallet, address topUp);
    event Swept(address indexed wallet, uint256 received, uint256 fee, uint256 credited);

    error ZeroAddress();
    error TokenHasNoCode();
    error NothingToSweep(address wallet);
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address feeRecipient_, address token_) {
        if (feeRecipient_ == address(0) || token_ == address(0)) revert ZeroAddress();
        if (token_.code.length == 0) revert TokenHasNoCode();
        feeRecipient = feeRecipient_;
        token = token_;
    }

    /// @notice The top-up address for `wallet`. Valid before the contract there is deployed.
    function topUpAddressOf(address wallet) public view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(wallet), _initCodeHash(wallet)));
        return address(uint160(uint256(h)));
    }

    /// @notice The fee BFA takes from `received` (rounded down, in the customer's favor).
    function feeOf(uint256 received) public pure returns (uint256) {
        return (received * FEE_NUMERATOR) / FEE_DENOMINATOR;
    }

    /// @notice Split the token balance at `wallet`'s top-up address: fee to `feeRecipient`, the rest to `wallet`.
    ///         Permissionless. Deploys the top-up contract on first use. Reverts with `NothingToSweep` if the
    ///         balance is zero (nothing is deployed in that case).
    function sweep(address wallet) external nonReentrant returns (uint256 received, uint256 fee, uint256 credited) {
        if (wallet == address(0)) revert ZeroAddress();
        address topUp = topUpAddressOf(wallet);
        if (token.balanceOf(topUp) == 0) revert NothingToSweep(wallet);
        if (topUp.code.length == 0) {
            new BfaTopUp{salt: _salt(wallet)}(token, feeRecipient, wallet);
            emit TopUpDeployed(wallet, topUp);
        }
        (received, fee, credited) = BfaTopUp(topUp).sweep();
        emit Swept(wallet, received, fee, credited);
    }

    function _salt(address wallet) private pure returns (bytes32) {
        return bytes32(uint256(uint160(wallet)));
    }

    function _initCodeHash(address wallet) private view returns (bytes32) {
        return keccak256(abi.encodePacked(type(BfaTopUp).creationCode, abi.encode(token, feeRecipient, wallet)));
    }
}
