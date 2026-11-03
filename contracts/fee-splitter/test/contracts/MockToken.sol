// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Test-only ERC-20 with 6 decimals (like USDC) and switchable misbehavior.
contract MockToken {
    enum Mode {
        Normal, // returns true
        ReturnFalse, // transfer returns false and moves nothing
        NoReturn, // transfer returns no data (USDT style)
        Reenter // transfer first calls `reenterTarget` with `reenterData`, records the result, then proceeds
    }

    string public constant name = "Mock USD Coin";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    Mode public mode;
    address public reenterTarget;
    bytes public reenterData;
    uint256 public reenterAttempts;
    bool public lastReenterOk;
    bytes public lastReenterReturn;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (mode == Mode.ReturnFalse) return false;
        if (mode == Mode.Reenter) {
            reenterAttempts += 1;
            (lastReenterOk, lastReenterReturn) = reenterTarget.call(reenterData);
        }
        _move(msg.sender, to, amount);
        if (mode == Mode.NoReturn) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
