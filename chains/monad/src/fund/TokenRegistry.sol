// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FeedConfig, FeedLeg, ITokenRegistry, Lane, PriceClass, TokenRecord, TokenStatus} from "../interfaces/IFund.sol";
import {LaneRegistry} from "./LaneRegistry.sol";

/// @title TokenRegistry
/// @notice Every token the fund agent's accounts may hold or trade
/// (FINAL_PLAN 0.4, D-340 to D-342, D-351), written clean-room.
///
/// - Each token records its lane, status, price class, decimals (read from the
///   token), per-token cap, its latest screen, and for class F its feed legs.
/// - Core lane: added through the 9-day timelock, or seeded by the constructor
///   (the deployment is the commitment, D-235). Usable by every account.
/// - Screened lane: added at once by the screener after a passing screen at
///   most six hours old (D-339), always class A, under the smaller cap; usable
///   only by personal accounts whose owner opted in onchain (D-351).
/// - Any token can be moved to SELL_ONLY or FROZEN at once by the screener, the
///   guardian or the admin. Nothing becomes buyable at once: restoring a token,
///   setting a feed, raising a cap or promoting a screened token to core all
///   wait the timelock.
contract TokenRegistry is LaneRegistry, ITokenRegistry {
    uint256 public constant BPS = 10_000;
    /// Most tokens the registry holds, so every list stays enumerable in one call.
    uint256 public constant MAX_TOKENS = 256;
    /// A screened token's cap may not exceed this (the class A per-position hard maximum, FINAL_PLAN 0.2).
    uint16 public constant MAX_SCREENED_POSITION_BPS = 1_500;
    /// A screen older than this cannot add a token (D-339).
    uint64 public constant SCREEN_TTL = 6 hours;

    /// Timelocked actions.
    uint8 public constant ADD_CORE = 1;
    uint8 public constant RESTORE = 2;
    uint8 public constant SET_FEED = 3;
    uint8 public constant SET_CAP = 4;
    uint8 public constant PROMOTE = 5;
    uint8 public constant SET_SCREENER = 6;
    uint8 public constant SET_GUARDIAN = 7;
    uint8 public constant SET_VERIFIER = 8;

    struct CoreSeed {
        address token;
        PriceClass priceClass;
        uint16 maxPositionBps;
        FeedConfig feed;
    }

    mapping(address token => TokenRecord) internal _tokens;
    mapping(address token => FeedConfig) internal _feeds;
    address[] public tokens;
    /// The class A attestation verifier (F-U12); zero until one is set through the timelock.
    address public verifier;

    event TokenAdded(address indexed token, Lane lane, PriceClass priceClass, uint8 decimals, uint16 maxPositionBps);
    event StatusSet(address indexed token, TokenStatus previous, TokenStatus current, address indexed by);
    event ScreenRecorded(address indexed token, bytes32 screenHash, uint64 screenedAt);
    event FeedSet(address indexed token, FeedConfig feed);
    event CapSet(address indexed token, uint16 maxPositionBps);
    event Promoted(address indexed token, PriceClass priceClass);
    event VerifierSet(address indexed previous, address indexed current);

    error ZeroAddress();
    error UnknownToken(address token);
    error AlreadyRegistered(address token);
    error TooManyTokens();
    error BadCap(uint16 maxPositionBps);
    error BadFeed(address token);
    error StaleScreen(uint64 screenedAt);
    error NotStricter(TokenStatus current, TokenStatus next);
    error NotLooser(TokenStatus current, TokenStatus next);
    error NotScreened(address token);
    error BadPayload();

    constructor(address admin, address guardian_, address screener_, CoreSeed[] memory seeds)
        LaneRegistry(admin, guardian_, screener_)
    {
        for (uint256 i = 0; i < seeds.length; ++i) {
            CoreSeed memory s = seeds[i];
            _checkCoreSeed(s);
            _add(s.token, Lane.CORE, s.priceClass, s.maxPositionBps, s.feed);
        }
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    function tokenRecord(address token) external view returns (TokenRecord memory) {
        return _tokens[token];
    }

    function feedOf(address token) external view returns (FeedConfig memory) {
        return _feeds[token];
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    /// Whether `account` may buy `token` now: a buyable core token, or a
    /// buyable screened token for a personal account whose owner opted in.
    function buyableFor(address token, address account) external view returns (bool) {
        TokenRecord memory r = _tokens[token];
        if (r.status != TokenStatus.BUYABLE) return false;
        if (r.lane == Lane.CORE) return true;
        return r.lane == Lane.SCREENED && _optedIn(account);
    }

    /// Whether `token` may be sold now: buyable or sell-only, never frozen.
    function sellable(address token) external view returns (bool) {
        TokenStatus s = _tokens[token].status;
        return s == TokenStatus.BUYABLE || s == TokenStatus.SELL_ONLY;
    }

    // ---------------------------------------------------------------------
    // The screener: screened tokens and screens, at once
    // ---------------------------------------------------------------------

    /// Adds a token to the screened lane after a passing screen (D-339, D-351):
    /// class A, the token's own decimals, a cap within the screened maximum.
    function addScreened(address token, uint16 maxPositionBps, bytes32 screenHash, uint64 screenedAt) external {
        _checkScreener();
        _checkFreshScreen(screenedAt);
        if (maxPositionBps == 0 || maxPositionBps > MAX_SCREENED_POSITION_BPS) revert BadCap(maxPositionBps);
        FeedConfig memory none;
        _add(token, Lane.SCREENED, PriceClass.A, maxPositionBps, none);
        _recordScreen(token, screenHash, screenedAt);
    }

    /// Records a newer passing screen for any registered token. It changes no status.
    function recordScreen(address token, bytes32 screenHash, uint64 screenedAt) external {
        _checkScreener();
        if (_tokens[token].lane == Lane.NONE) revert UnknownToken(token);
        _checkFreshScreen(screenedAt);
        _recordScreen(token, screenHash, screenedAt);
    }

    // ---------------------------------------------------------------------
    // Instant tightening: the screener, the guardian or the admin
    // ---------------------------------------------------------------------

    /// Only sells from now on.
    function setSellOnly(address token) external {
        _checkTightener();
        _tighten(token, TokenStatus.SELL_ONLY);
    }

    /// No trades at all; owners still withdraw it in kind.
    function freeze(address token) external {
        _checkTightener();
        _tighten(token, TokenStatus.FROZEN);
    }

    /// Lowers a token's cap at once; raising it waits the timelock.
    function lowerCap(address token, uint16 maxPositionBps) external {
        _checkTightener();
        TokenRecord storage r = _tokens[token];
        if (r.lane == Lane.NONE) revert UnknownToken(token);
        if (maxPositionBps >= r.maxPositionBps) revert BadCap(maxPositionBps);
        r.maxPositionBps = maxPositionBps;
        emit CapSet(token, maxPositionBps);
    }

    // ---------------------------------------------------------------------
    // Timelocked loosening
    // ---------------------------------------------------------------------

    function _validateChange(uint8 action, bytes calldata data) internal view override {
        if (action == ADD_CORE) {
            CoreSeed memory s = abi.decode(data, (CoreSeed));
            if (_tokens[s.token].lane != Lane.NONE) revert AlreadyRegistered(s.token);
            _checkCoreSeed(s);
        } else if (action == RESTORE) {
            (address token, TokenStatus next) = abi.decode(data, (address, TokenStatus));
            TokenStatus current = _tokens[token].status;
            if (current == TokenStatus.NONE) revert UnknownToken(token);
            if (next == TokenStatus.NONE || uint8(next) >= uint8(current)) revert NotLooser(current, next);
        } else if (action == SET_FEED) {
            (address token, FeedConfig memory feed) = abi.decode(data, (address, FeedConfig));
            if (_tokens[token].lane != Lane.CORE) revert UnknownToken(token);
            _checkFeed(token, feed);
        } else if (action == SET_CAP) {
            (address token, uint16 cap) = abi.decode(data, (address, uint16));
            TokenRecord memory r = _tokens[token];
            if (r.lane == Lane.NONE) revert UnknownToken(token);
            uint16 max = r.lane == Lane.SCREENED ? MAX_SCREENED_POSITION_BPS : uint16(BPS);
            if (cap == 0 || cap > max) revert BadCap(cap);
        } else if (action == PROMOTE) {
            (address token, PriceClass cls, FeedConfig memory feed) =
                abi.decode(data, (address, PriceClass, FeedConfig));
            if (_tokens[token].lane != Lane.SCREENED) revert NotScreened(token);
            if (cls == PriceClass.F) _checkFeed(token, feed);
            else if (cls != PriceClass.A) revert BadPayload();
        } else if (action == SET_SCREENER || action == SET_GUARDIAN || action == SET_VERIFIER) {
            abi.decode(data, (address));
        } else {
            revert BadPayload();
        }
    }

    function _applyChange(uint8 action, bytes calldata data) internal override {
        if (action == ADD_CORE) {
            CoreSeed memory s = abi.decode(data, (CoreSeed));
            _add(s.token, Lane.CORE, s.priceClass, s.maxPositionBps, s.feed);
        } else if (action == RESTORE) {
            (address token, TokenStatus next) = abi.decode(data, (address, TokenStatus));
            _setStatus(token, next);
        } else if (action == SET_FEED) {
            (address token, FeedConfig memory feed) = abi.decode(data, (address, FeedConfig));
            _tokens[token].priceClass = PriceClass.F;
            _feeds[token] = feed;
            emit FeedSet(token, feed);
        } else if (action == SET_CAP) {
            (address token, uint16 cap) = abi.decode(data, (address, uint16));
            _tokens[token].maxPositionBps = cap;
            emit CapSet(token, cap);
        } else if (action == PROMOTE) {
            (address token, PriceClass cls, FeedConfig memory feed) =
                abi.decode(data, (address, PriceClass, FeedConfig));
            TokenRecord storage r = _tokens[token];
            r.lane = Lane.CORE;
            r.priceClass = cls;
            if (cls == PriceClass.F) {
                _feeds[token] = feed;
                emit FeedSet(token, feed);
            }
            emit Promoted(token, cls);
        } else if (action == SET_SCREENER) {
            _setScreener(abi.decode(data, (address)));
        } else if (action == SET_GUARDIAN) {
            _setGuardian(abi.decode(data, (address)));
        } else {
            address next = abi.decode(data, (address));
            emit VerifierSet(verifier, next);
            verifier = next;
        }
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _add(address token, Lane lane, PriceClass cls, uint16 cap, FeedConfig memory feed) internal {
        if (token == address(0)) revert ZeroAddress();
        if (_tokens[token].lane != Lane.NONE) revert AlreadyRegistered(token);
        if (tokens.length >= MAX_TOKENS) revert TooManyTokens();
        uint8 decimals = IERC20Metadata(token).decimals();
        _tokens[token] = TokenRecord({
            lane: lane,
            status: TokenStatus.BUYABLE,
            priceClass: cls,
            decimals: decimals,
            maxPositionBps: cap,
            screenedAt: 0,
            screenHash: bytes32(0)
        });
        if (cls == PriceClass.F) {
            _feeds[token] = feed;
            emit FeedSet(token, feed);
        }
        tokens.push(token);
        emit TokenAdded(token, lane, cls, decimals, cap);
    }

    function _checkCoreSeed(CoreSeed memory s) internal view {
        if (s.token == address(0)) revert ZeroAddress();
        if (s.maxPositionBps == 0 || s.maxPositionBps > BPS) revert BadCap(s.maxPositionBps);
        if (s.priceClass == PriceClass.F) _checkFeed(s.token, s.feed);
        else if (s.priceClass != PriceClass.A) revert BadPayload();
    }

    /// A feed config is a USD leg, and optionally a rate leg, each with a
    /// nonzero bound and decimals no more than 18, and code at the proxy.
    function _checkFeed(address token, FeedConfig memory f) internal view {
        if (!_legOk(f.usd)) revert BadFeed(token);
        if (f.rate.feed != address(0) && !_legOk(f.rate)) revert BadFeed(token);
    }

    function _legOk(FeedLeg memory l) internal view returns (bool) {
        return l.feed != address(0) && l.feed.code.length > 0 && l.decimals <= 18 && l.maxAge > 0;
    }

    function _checkFreshScreen(uint64 screenedAt) internal view {
        // forge-lint: disable-next-line(block-timestamp)
        if (screenedAt > block.timestamp || block.timestamp - screenedAt > SCREEN_TTL) revert StaleScreen(screenedAt);
    }

    function _recordScreen(address token, bytes32 screenHash, uint64 screenedAt) internal {
        TokenRecord storage r = _tokens[token];
        r.screenHash = screenHash;
        r.screenedAt = screenedAt;
        emit ScreenRecorded(token, screenHash, screenedAt);
    }

    function _tighten(address token, TokenStatus next) internal {
        TokenStatus current = _tokens[token].status;
        if (current == TokenStatus.NONE) revert UnknownToken(token);
        if (uint8(next) <= uint8(current)) revert NotStricter(current, next);
        _setStatus(token, next);
    }

    function _setStatus(address token, TokenStatus next) internal {
        TokenRecord storage r = _tokens[token];
        emit StatusSet(token, r.status, next, msg.sender);
        r.status = next;
    }
}
