// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title SafeTransfer
/// @notice Minimal SafeERC20-style helpers. A transfer counts as successful only if the call does not revert
///         and returns either nothing or ABI-encoded `true`. USDC returns `true`.
library SafeTransfer {
    error TransferFailed(address token, address to, uint256 amount);
    error BalanceQueryFailed(address token);

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            revert TransferFailed(token, to, amount);
        }
    }

    function balanceOf(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || ret.length < 32) revert BalanceQueryFailed(token);
        return abi.decode(ret, (uint256));
    }
}
