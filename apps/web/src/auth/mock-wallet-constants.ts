/**
 * TEST BUILDS ONLY: the mock wallet's identity, shared by the mock wallet
 * provider (browser) and the mock server identity (claim route). Only modules
 * that test builds alias in import this, so a real build never contains it;
 * `scripts/check-web-build.js` fails if the marker appears in one.
 */
export const MOCK_WALLET_MARKER = "alpha-agents-mock-wallet-e2e-only";
export const MOCK_WALLET_ADDRESS = "0x00000000000000000000000000000000000e2e01";
/** The access token the mock wallet hands the server. */
export const MOCK_ACCESS_TOKEN = `mock-token-${MOCK_WALLET_MARKER}`;
