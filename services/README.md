# services

Long-running backend services, one subfolder each: orchestrator, tool servers (chain, data, platform), bot runner, workflow runner, Risk Sentinel, signer, indexer, narrator, and the audit pipeline. Added by the units that build them.

- `indexer` (P1-U4): the chain log poller.
- `orchestrator` (P1-U5): provisioning, the reveal keeper, sandbox leases, the gate and the startup sweep; `src/spike` keeps the P1-U1 spike driver.
- `platform-tools` (P1-U1): the spike's stub tools server, until P1-U7.
