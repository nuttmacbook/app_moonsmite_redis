// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

// Wages for smiths: players who strike other players' weapons for a share of the value they add.
//
// The game server keeps who struck what and signs a bill per weapon (smiths and amounts). The
// weapon's owner pays the bill here in MWLD; each smith's share waits in this contract until the
// smith claims it. MWLD held for smiths can only leave through claim(): transferToken cannot touch
// it, so the owner of this contract cannot take wages that were paid in.

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

contract Constant {
    uint256 constant MAX = type(uint256).max;

    address constant ZERO = address(0);
    address constant DEAD = address(0xdead);

    // Smiths paid by one bill (the game server never signs more)
    uint256 constant MAX_BILL_SMITHS = 20;

    // secp256k1n / 2: signatures with a higher s are the malleable twin and are refused
    uint256 constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
}

contract Storage is Constant {
    bool _initialized;
    address _owner;

    IERC20 _coin;                       // MWLD
    address _signer;                    // the game server's signer (same key as the Forge contract)
    uint256 _txFee;                     // native fee every write sends

    struct Smith {
        uint256 claimable;              // paid in by owners, not claimed yet
        uint256 claimed;                // already sent to the smith
        uint256 earned;                 // everything ever paid in for this smith
    }

    mapping (address => Smith) smith;

    struct Bill {                       // signed by the game server for one weapon
        uint256 tokenId;
        address[] smiths;
        uint256[] amounts;
        bytes32 billId;
        uint256 deadline;
    }

    mapping (bytes32 => bool) paidBill; // bill id -> paid; a bill pays once

    uint256 _totalOwed;                 // MWLD this contract holds for smiths
    uint256 _totalPaid;                 // MWLD ever paid in
    uint256 _billCount;
    bool _locked;                       // re-entrancy guard
}

contract WagesEngine is Storage {
    error AlreadyInitialized();
    error OnlyOwner();
    error FeeRequired();
    error ZeroAddress();
    error BillExpired();
    error BillAlreadyPaid();
    error BillSize();
    error BillIsZero();
    error NotSignedByGame();
    error PaymentFailed();
    error NothingToClaim();
    error WagesLocked();
    error Reentrant();

    event OwnershipTransferred(address owner, address newOwner);
    event SignerChanged(address signer);
    event TxFeeChanged(uint256 txFee);
    event WagesPaid(bytes32 indexed billId, uint256 indexed tokenId, address indexed payer, uint256 total, uint256 smiths);
    event WagesClaimed(address indexed account, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != _owner) revert OnlyOwner();
        _;
    }

    modifier withFee() {
        if (msg.value < _txFee) revert FeeRequired();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrant();
        _locked = true;
        _;
        _locked = false;
    }

    function initialize(address owner_, address coin_, address signer_) external {
        if (_initialized) revert AlreadyInitialized();
        if (owner_ == ZERO || coin_ == ZERO || signer_ == ZERO) revert ZeroAddress();
        _initialized = true;
        _owner = owner_;
        _coin = IERC20(coin_);
        _signer = signer_;
        _initialize();
    }

    function _initialize() internal {
        _txFee = 0.0001 ether;
    }

    function getProxyInfo() public view returns (address, bool) {
        return (_owner, _initialized);
    }

    /* ------------------------------------------------------------ views */

    /// coin, signer, txFee, MWLD held for smiths, MWLD ever paid in, bills paid
    function getDappInfo() public view returns (address, address, uint256, uint256, uint256, uint256) {
        return (address(_coin), _signer, _txFee, _totalOwed, _totalPaid, _billCount);
    }

    function getSmithInfo(address account_) public view returns (Smith memory) {
        return smith[account_];
    }

    function isBillPaid(bytes32 billId_) public view returns (bool) {
        return paidBill[billId_];
    }

    /* ------------------------------------------------------------ wages */

    /**
     * Pays the wages one weapon owes, as the game server billed them. The bill is signed for the
     * caller only, works once, and runs out at its deadline. Pulls the total in MWLD from the
     * caller (approve this contract first) and books each smith's share for them to claim.
     */
    function pay(Bill calldata bill_, bytes calldata sig_) external payable withFee nonReentrant {
        _checkBill(bill_, sig_);
        uint256 total = _sum(bill_);

        // Count what really arrived, so a token that takes a cut on transfer can never leave
        // smiths owed more than this contract holds
        uint256 before = _coin.balanceOf(address(this));
        _pull(msg.sender, total);
        if (_coin.balanceOf(address(this)) - before != total) revert PaymentFailed();

        paidBill[bill_.billId] = true;
        for (uint256 i = 0; i < bill_.smiths.length; i++) {
            Smith storage s = smith[bill_.smiths[i]];
            s.claimable += bill_.amounts[i];
            s.earned += bill_.amounts[i];
        }
        _totalOwed += total;
        _totalPaid += total;
        _billCount += 1;

        emit WagesPaid(bill_.billId, bill_.tokenId, msg.sender, total, bill_.smiths.length);
    }

    /// Sends the caller every wage paid in for them
    function claim() external payable withFee nonReentrant {
        Smith storage s = smith[msg.sender];
        uint256 amount = s.claimable;
        if (amount == 0) revert NothingToClaim();

        s.claimable = 0;
        s.claimed += amount;
        _totalOwed -= amount;
        _push(msg.sender, amount);

        emit WagesClaimed(msg.sender, amount);
    }

    /* ------------------------------------------------------------ owner */

    function setSigner(address signer_) public onlyOwner {
        if (signer_ == ZERO) revert ZeroAddress();
        _signer = signer_;
        emit SignerChanged(signer_);
    }

    function setTxFee(uint256 txFee_) public onlyOwner {
        _txFee = txFee_;
        emit TxFeeChanged(txFee_);
    }

    function transferOwnership(address newOwner) public onlyOwner {
        if (newOwner == ZERO) revert ZeroAddress();
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    function transferETH(address to, uint256 amount) public onlyOwner {
        require(to != ZERO, "send ETH to zero");
        (bool success, ) = to.call{value: amount}("");
        require(success, "send ETH fail");
    }

    /// Rescues tokens sent here by mistake. MWLD held for smiths stays: only claim() moves it
    function transferToken(address token, address to, uint256 amount) public onlyOwner {
        if (token == address(_coin) && _coin.balanceOf(address(this)) < _totalOwed + amount) revert WagesLocked();
        _send(token, to, amount);
    }

    receive() external payable {}

    /* ------------------------------------------------------------ internal */

    /// Fresh, unpaid, the right size, and signed by the game server for this caller
    function _checkBill(Bill calldata bill_, bytes calldata sig_) internal view {
        if (block.timestamp > bill_.deadline) revert BillExpired();
        if (paidBill[bill_.billId]) revert BillAlreadyPaid();
        uint256 count = bill_.smiths.length;
        if (count == 0 || count > MAX_BILL_SMITHS || count != bill_.amounts.length) revert BillSize();
        if (_recover(_billHash(bill_), sig_) != _signer) revert NotSignedByGame();
    }

    /// What the game server signed: this contract, this chain, the payer, and the bill.
    /// Its own function with no other locals, so the 9 values fit the stack
    function _billHash(Bill calldata bill_) internal view returns (bytes32) {
        return keccak256(abi.encode(
            address(this), block.chainid, "WAGES", msg.sender,
            bill_.tokenId, bill_.smiths, bill_.amounts, bill_.billId, bill_.deadline
        ));
    }

    function _sum(Bill calldata bill_) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < bill_.smiths.length; i++) {
            if (bill_.smiths[i] == ZERO) revert ZeroAddress();
            total += bill_.amounts[i];
        }
        if (total == 0) revert BillIsZero();
    }

    /// The signer of an Ethereum signed message over a 32-byte hash (what ethers signMessage makes)
    function _recover(bytes32 hash_, bytes calldata sig_) internal pure returns (address) {
        if (sig_.length != 65) return ZERO;
        bytes32 r = bytes32(sig_[0:32]);
        bytes32 s = bytes32(sig_[32:64]);
        uint8 v = uint8(sig_[64]);
        if (v < 27) v += 27;
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) return ZERO;
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash_));
        return ecrecover(digest, v, r, s);
    }

    /// transferFrom that also accepts tokens which return nothing
    function _pull(address from_, uint256 amount_) internal {
        (bool ok, bytes memory data) = address(_coin).call(abi.encodeCall(IERC20.transferFrom, (from_, address(this), amount_)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert PaymentFailed();
    }

    function _push(address to_, uint256 amount_) internal {
        _send(address(_coin), to_, amount_);
    }

    /// transfer that also accepts tokens which return nothing, and fails loudly otherwise
    function _send(address token_, address to_, uint256 amount_) internal {
        (bool ok, bytes memory data) = token_.call(abi.encodeCall(IERC20.transfer, (to_, amount_)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert PaymentFailed();
    }
}
