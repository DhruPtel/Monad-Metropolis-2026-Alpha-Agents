# services/indexer

The chain indexer (P1-U4, D-197): a JSON-RPC log poller behind a `LogSource` interface. It stores every AgentNFT event, the agents projection and agents' USDC transfers in the `indexer` schema, each record with its block number and hash, and a watermark with the last block's hash. Before each range it checks that hash; a reorg or a rewound fork rolls the index back to the newest block the chain still has and is recorded in `indexer.incidents`. Run it with `pnpm dev:indexer` (`--once` to catch up and exit).
