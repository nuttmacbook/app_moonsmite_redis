// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

// EIP-1967 proxy for WagesEngine. Deploy WagesEngine first, then this with
// _data = abi.encodeCall(WagesEngine.initialize, (owner, MWLD, signer)), so initialize runs in the
// same transaction and nobody can initialize it first. VITE_WAGES_ADDRESS = this contract.

contract WagesProxy {
    // bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    // bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)
    bytes32 constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);
    event AdminChanged(address previousAdmin, address newAdmin);

    modifier onlyAdmin() {
        require(msg.sender == _admin(), "Not admin");
        _;
    }

    constructor(address _impl, bytes memory _data) {
        _setAdmin(msg.sender);
        _setImplementation(_impl);
        if (_data.length > 0) {
            (bool success, ) = _impl.delegatecall(_data);
            require(success, "Init failed");
        }
    }

    function upgradeTo(address impl_) external onlyAdmin {
        _setImplementation(impl_);
    }

    function upgradeToAndCall(address impl_, bytes calldata data_) external payable onlyAdmin {
        _setImplementation(impl_);
        (bool success, ) = impl_.delegatecall(data_);
        require(success, "Call failed");
    }

    function transferAdmin(address admin_) external onlyAdmin {
        require(admin_ != address(0), "Zero admin");
        emit AdminChanged(_admin(), admin_);
        _setAdmin(admin_);
    }

    function getProxyAdmin() external view returns (address) {
        return _admin();
    }

    function getImplementation() external view returns (address) {
        return _implementation();
    }

    fallback() external payable {
        _delegate(_implementation());
    }

    receive() external payable {
        _delegate(_implementation());
    }

    function _admin() internal view returns (address admin) {
        bytes32 slot = ADMIN_SLOT;
        assembly { admin := sload(slot) }
    }

    function _setAdmin(address admin_) internal {
        bytes32 slot = ADMIN_SLOT;
        assembly { sstore(slot, admin_) }
    }

    function _implementation() internal view returns (address impl) {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly { impl := sload(slot) }
    }

    function _setImplementation(address impl_) internal {
        require(impl_.code.length > 0, "Not a contract");
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly { sstore(slot, impl_) }
        emit Upgraded(impl_);
    }

    function _delegate(address impl_) internal {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl_, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
