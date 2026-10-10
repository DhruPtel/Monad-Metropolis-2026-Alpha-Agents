// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IPoolRegistry, ITokenRegistry, Lane, PoolRecord, PoolStatus, TokenRecord, Venue} from "../interfaces/IFund.sol";
import {PoolKey} from "../interfaces/IUniswap.sol";
import {IUniswapV3FactoryView, IUniswapV3PoolView} from "../interfaces/IUniswapV3.sol";
import {IUniswapV4StateView} from "../interfaces/IOracle.sol";
import {LaneRegistry} from "./LaneRegistry.sol";

/// @title ProtocolRegistryV3
/// @notice The deny-by-default list of route adapters and pools the fund
/// agent's trades may use (FINAL_PLAN 0.4, D-341, D-342), written clean-room.
///
/// - Adapters are pinned by their code hash; a changed adapter fails closed.
/// - Pools are registered per token pair on Uniswap v3, PancakeSwap v3 or
///   hookless Uniswap v4, each checked against its venue when added (a v3 pool
///   must be what its own factory returns; a v4 pool's ID must be the hash of
///   its hookless key, and initialized), and pinned by code hash: the v3 pool's
///   own code, or v4's PoolManager's. Each venue's code hash is pinned too, so
///   an upgraded venue fails closed.
/// - Two lanes, as for tokens: core pools through the 9-day timelock (or the
///   constructor), usable by every account; screened pools added at once by
///   the screener, usable only by opted-in personal accounts. Pausing or
///   setting a pool exit-only is instant for the screener, the guardian and the
///   admin; activating waits the timelock.
contract ProtocolRegistryV3 is LaneRegistry, IPoolRegistry {
    /// Most pools the registry holds, so the list stays enumerable in one call.
    uint256 public constant MAX_POOLS = 256;

    /// Timelocked actions.
    uint8 public constant ADD_CORE_POOL = 1;
    uint8 public constant ACTIVATE_POOL = 2;
    uint8 public constant ADD_ADAPTER = 3;
    uint8 public constant ACTIVATE_ADAPTER = 4;
    uint8 public constant SET_SCREENER = 5;
    uint8 public constant SET_GUARDIAN = 6;

    struct AdapterEntry {
        address adapter;
        bool active;
        bytes32 codeHash;
    }

    struct PoolSeed {
        Venue venue;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
        address pool;
    }

    ITokenRegistry public immutable TOKENS;
    address public immutable UNISWAP_V3_FACTORY;
    address public immutable PANCAKESWAP_V3_FACTORY;
    address public immutable POOL_MANAGER;
    IUniswapV4StateView public immutable STATE_VIEW;
    /// Wrapped MON: a v4 pool's native MON side counts as it.
    address public immutable WMON;
    address public immutable USDC;
    bytes32 public immutable UNISWAP_V3_FACTORY_HASH;
    bytes32 public immutable PANCAKESWAP_V3_FACTORY_HASH;
    bytes32 public immutable POOL_MANAGER_HASH;

    mapping(bytes32 poolId => PoolRecord) internal _pools;
    bytes32[] public poolIds;
    mapping(bytes32 adapterId => AdapterEntry) internal _adapters;
    bytes32[] public adapterIds;

    event PoolAdded(bytes32 indexed poolId, Lane lane, Venue venue, address token0, address token1, uint24 fee);
    event PoolStatusSet(bytes32 indexed poolId, PoolStatus previous, PoolStatus current, address indexed by);
    event AdapterAdded(bytes32 indexed adapterId, address indexed adapter, bytes32 codeHash);
    event AdapterStatusSet(bytes32 indexed adapterId, bool active, address indexed by);

    error ZeroAddress();
    error UnknownPool(bytes32 poolId);
    error PoolExists(bytes32 poolId);
    error TooManyPools();
    error NotAPool(bytes32 poolId);
    error TokenNotListed(address token);
    error PoolUnusable(bytes32 poolId);
    error UnknownAdapter(bytes32 adapterId);
    error AdapterExists(bytes32 adapterId);
    error NotStricter(PoolStatus current, PoolStatus next);
    error BadPayload();

    struct Venues {
        address uniswapV3Factory;
        address pancakeswapV3Factory;
        address poolManager;
        IUniswapV4StateView stateView;
        address wmon;
        address usdc;
    }

    constructor(
        address admin,
        address guardian_,
        address screener_,
        ITokenRegistry tokens_,
        Venues memory v,
        PoolSeed[] memory seeds,
        bytes32[] memory adapterIds_,
        address[] memory adapters
    ) LaneRegistry(admin, guardian_, screener_) {
        if (
            address(tokens_) == address(0) || v.uniswapV3Factory == address(0) || v.pancakeswapV3Factory == address(0)
                || v.poolManager == address(0) || address(v.stateView) == address(0) || v.wmon == address(0)
                || v.usdc == address(0)
        ) revert ZeroAddress();
        if (adapterIds_.length != adapters.length) revert BadPayload();
        TOKENS = tokens_;
        UNISWAP_V3_FACTORY = v.uniswapV3Factory;
        PANCAKESWAP_V3_FACTORY = v.pancakeswapV3Factory;
        POOL_MANAGER = v.poolManager;
        STATE_VIEW = v.stateView;
        WMON = v.wmon;
        USDC = v.usdc;
        UNISWAP_V3_FACTORY_HASH = v.uniswapV3Factory.codehash;
        PANCAKESWAP_V3_FACTORY_HASH = v.pancakeswapV3Factory.codehash;
        POOL_MANAGER_HASH = v.poolManager.codehash;
        for (uint256 i = 0; i < seeds.length; ++i) {
            (bytes32 id, PoolRecord memory r) = _checkPool(seeds[i], Lane.CORE);
            _addPool(id, r);
        }
        for (uint256 i = 0; i < adapters.length; ++i) {
            _addAdapter(adapterIds_[i], adapters[i], true);
        }
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    function pool(bytes32 poolId) external view returns (PoolRecord memory) {
        return _pools[poolId];
    }

    function poolCount() external view returns (uint256) {
        return poolIds.length;
    }

    function adapter(bytes32 adapterId) external view returns (AdapterEntry memory) {
        return _adapters[adapterId];
    }

    /// The adapter to trade through, or zero when it is unknown, inactive or its code changed.
    function adapterFor(bytes32 adapterId) external view returns (address) {
        AdapterEntry memory e = _adapters[adapterId];
        if (!e.active || e.adapter.codehash != e.codeHash) return address(0);
        return e.adapter;
    }

    /// @inheritdoc IPoolRegistry
    function usablePool(bytes32 poolId, bool allowScreened, bool toUsdc) external view returns (PoolRecord memory r) {
        r = _pools[poolId];
        bool statusOk = r.status == PoolStatus.ACTIVE || (r.status == PoolStatus.EXIT_ONLY && toUsdc);
        bool laneOk = r.lane == Lane.CORE || (r.lane == Lane.SCREENED && allowScreened);
        if (!statusOk || !laneOk || !_codeIntact(r)) revert PoolUnusable(poolId);
    }

    /// The ID a pool is registered under: a v3 pool's address, or a v4 pool's ID.
    function poolIdOf(PoolSeed memory s) public pure returns (bytes32) {
        if (s.venue == Venue.UNISWAP_V4) {
            return keccak256(
                abi.encode(
                    PoolKey({
                        currency0: s.token0,
                        currency1: s.token1,
                        fee: s.fee,
                        tickSpacing: s.tickSpacing,
                        hooks: address(0)
                    })
                )
            );
        }
        return bytes32(uint256(uint160(s.pool)));
    }

    // ---------------------------------------------------------------------
    // The screener: screened pools, at once
    // ---------------------------------------------------------------------

    /// Adds a pool to the screened lane. Its tokens must be listed (either lane).
    function addScreenedPool(PoolSeed calldata s) external returns (bytes32 id) {
        _checkScreener();
        PoolRecord memory r;
        (id, r) = _checkPool(s, Lane.SCREENED);
        _addPool(id, r);
    }

    // ---------------------------------------------------------------------
    // Instant tightening
    // ---------------------------------------------------------------------

    function pausePool(bytes32 poolId) external {
        _checkTightener();
        _tightenPool(poolId, PoolStatus.PAUSED);
    }

    function setPoolExitOnly(bytes32 poolId) external {
        _checkTightener();
        _tightenPool(poolId, PoolStatus.EXIT_ONLY);
    }

    function pauseAdapter(bytes32 adapterId) external {
        _checkTightener();
        AdapterEntry storage e = _adapters[adapterId];
        if (e.adapter == address(0)) revert UnknownAdapter(adapterId);
        e.active = false;
        emit AdapterStatusSet(adapterId, false, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Timelocked loosening
    // ---------------------------------------------------------------------

    function _validateChange(uint8 action, bytes calldata data) internal view override {
        if (action == ADD_CORE_POOL) {
            _checkPool(abi.decode(data, (PoolSeed)), Lane.CORE);
        } else if (action == ACTIVATE_POOL) {
            bytes32 id = abi.decode(data, (bytes32));
            if (_pools[id].status == PoolStatus.NONE) revert UnknownPool(id);
        } else if (action == ADD_ADAPTER) {
            (bytes32 id, address a) = abi.decode(data, (bytes32, address));
            if (a == address(0)) revert ZeroAddress();
            if (_adapters[id].adapter != address(0)) revert AdapterExists(id);
        } else if (action == ACTIVATE_ADAPTER) {
            bytes32 id = abi.decode(data, (bytes32));
            if (_adapters[id].adapter == address(0)) revert UnknownAdapter(id);
        } else if (action == SET_SCREENER || action == SET_GUARDIAN) {
            abi.decode(data, (address));
        } else {
            revert BadPayload();
        }
    }

    function _applyChange(uint8 action, bytes calldata data) internal override {
        if (action == ADD_CORE_POOL) {
            (bytes32 id, PoolRecord memory r) = _checkPool(abi.decode(data, (PoolSeed)), Lane.CORE);
            _addPool(id, r);
        } else if (action == ACTIVATE_POOL) {
            bytes32 id = abi.decode(data, (bytes32));
            PoolRecord storage r = _pools[id];
            emit PoolStatusSet(id, r.status, PoolStatus.ACTIVE, msg.sender);
            r.status = PoolStatus.ACTIVE;
        } else if (action == ADD_ADAPTER) {
            (bytes32 id, address a) = abi.decode(data, (bytes32, address));
            _addAdapter(id, a, false);
        } else if (action == ACTIVATE_ADAPTER) {
            bytes32 id = abi.decode(data, (bytes32));
            AdapterEntry storage e = _adapters[id];
            // Activation re-pins the code that was reviewed.
            e.codeHash = e.adapter.codehash;
            e.active = true;
            emit AdapterStatusSet(id, true, msg.sender);
        } else if (action == SET_SCREENER) {
            _setScreener(abi.decode(data, (address)));
        } else {
            _setGuardian(abi.decode(data, (address)));
        }
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// Checks a pool against its venue and the token registry, and builds its record.
    function _checkPool(PoolSeed memory s, Lane lane) internal view returns (bytes32 id, PoolRecord memory r) {
        if (s.token0 >= s.token1) revert BadPayload();
        id = poolIdOf(s);
        if (_pools[id].status != PoolStatus.NONE) revert PoolExists(id);
        _checkListed(s.token0, lane);
        _checkListed(s.token1, lane);
        bytes32 codeHash;
        if (s.venue == Venue.UNISWAP_V4) {
            if (s.pool != address(0)) revert BadPayload();
            (uint160 sqrtPriceX96,,,) = STATE_VIEW.getSlot0(id);
            if (sqrtPriceX96 == 0) revert NotAPool(id);
            codeHash = POOL_MANAGER.codehash;
        } else if (s.venue == Venue.UNISWAP_V3 || s.venue == Venue.PANCAKESWAP_V3) {
            address factory = s.venue == Venue.UNISWAP_V3 ? UNISWAP_V3_FACTORY : PANCAKESWAP_V3_FACTORY;
            if (s.pool == address(0) || s.pool.code.length == 0) revert NotAPool(id);
            if (IUniswapV3FactoryView(factory).getPool(s.token0, s.token1, s.fee) != s.pool) revert NotAPool(id);
            IUniswapV3PoolView p = IUniswapV3PoolView(s.pool);
            if (p.token0() != s.token0 || p.token1() != s.token1 || p.fee() != s.fee) revert NotAPool(id);
            if (p.tickSpacing() != s.tickSpacing) revert NotAPool(id);
            codeHash = s.pool.codehash;
        } else {
            revert BadPayload();
        }
        r = PoolRecord({
            lane: lane,
            status: PoolStatus.ACTIVE,
            venue: s.venue,
            token0: s.token0,
            token1: s.token1,
            fee: s.fee,
            tickSpacing: s.tickSpacing,
            pool: s.pool,
            codeHash: codeHash
        });
    }

    /// A core pool's tokens must both be core; a screened pool's, listed in either lane.
    function _checkListed(address token, Lane lane) internal view {
        address held = token == address(0) ? WMON : token;
        TokenRecord memory t = TOKENS.tokenRecord(held);
        if (t.lane == Lane.NONE || (lane == Lane.CORE && t.lane != Lane.CORE)) revert TokenNotListed(held);
    }

    function _codeIntact(PoolRecord memory r) internal view returns (bool) {
        if (r.venue == Venue.UNISWAP_V4) {
            return POOL_MANAGER.codehash == POOL_MANAGER_HASH && r.codeHash == POOL_MANAGER_HASH;
        }
        bytes32 factoryHash =
            r.venue == Venue.UNISWAP_V3 ? UNISWAP_V3_FACTORY.codehash : PANCAKESWAP_V3_FACTORY.codehash;
        bytes32 pinned = r.venue == Venue.UNISWAP_V3 ? UNISWAP_V3_FACTORY_HASH : PANCAKESWAP_V3_FACTORY_HASH;
        return factoryHash == pinned && r.pool.codehash == r.codeHash;
    }

    function _addPool(bytes32 id, PoolRecord memory r) internal {
        if (poolIds.length >= MAX_POOLS) revert TooManyPools();
        _pools[id] = r;
        poolIds.push(id);
        emit PoolAdded(id, r.lane, r.venue, r.token0, r.token1, r.fee);
    }

    function _tightenPool(bytes32 id, PoolStatus next) internal {
        PoolRecord storage r = _pools[id];
        if (r.status == PoolStatus.NONE) revert UnknownPool(id);
        if (uint8(next) <= uint8(r.status)) revert NotStricter(r.status, next);
        emit PoolStatusSet(id, r.status, next, msg.sender);
        r.status = next;
    }

    function _addAdapter(bytes32 id, address a, bool active) internal {
        if (a == address(0)) revert ZeroAddress();
        if (_adapters[id].adapter != address(0)) revert AdapterExists(id);
        _adapters[id] = AdapterEntry(a, active, a.codehash);
        adapterIds.push(id);
        emit AdapterAdded(id, a, a.codehash);
        if (active) emit AdapterStatusSet(id, true, msg.sender);
    }
}
