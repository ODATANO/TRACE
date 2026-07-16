# Smart Contract & OData API

## Aiken Validators

Two validators live in `contracts/contracts-aiken/validators/` (full datum/redeemer
reference incl. the Pebble cross-check build: [contracts/README.md](../contracts/README.md)).

### `pharma_trace` — batch custody

**Mint policy:** Only the manufacturer (parameterized VKH) can mint, exactly 1 token per tx.

**Spend validator:** Transfers require:
1. Current holder's signature
2. A continuing output with updated datum (`current_holder = next_holder`, `step + 1`)

```
Datum:    ChainOfCustody { manufacturer, current_holder, batch_id, step }
Redeemer: Action::Transfer { next_holder }
```

### `cold_chain` — condition monitoring

A per-batch temperature monitor as an on-chain state thread: `InitColdChainMonitor`
locks a `MonitorDatum` (allowed range, reading digest chain) at the script address,
each `RecordSensorReadings` spends and re-locks it with the updated state — the
validator enforces that out-of-range readings flip `breached = true` and that the
flag can never be cleared again — and `CloseColdChainMonitor` seals the thread.
`VerifyBatch` exposes the result publicly (`coldChain.breached`, excursion count).

## OData Actions

| Action | Description |
|--------|-------------|
| `MintBatchNft(batchId)` | Build unsigned mint tx |
| `TransferBatch(batchId, toParticipantId, ...)` | Build unsigned transfer tx |
| `SubmitSigned(buildId, signedTxCbor)` | Submit externally signed tx |
| `CheckPendingTransactions()` | Poll SUBMITTED events |
| `RetryFailedTransaction(proofEventId)` | Rebuild failed tx |
| `AnchorDocument(batchId, documentHash, ...)` | Anchor doc hash on-chain |
| `AnchorColdChain(batchId, telemetryHash, ...)` | Anchor cold-chain telemetry (CIP-20 metadata) |
| `InitColdChainMonitor(batchId, minMilliC, maxMilliC, ...)` | Open an on-chain monitor (Plutus lock) |
| `RecordSensorReadings(monitorId, readingsJson)` | Commit readings, breach detection on-chain |
| `CloseColdChainMonitor(monitorId)` | Seal the monitor thread |
| `VerifyBatch(batchIdOrFingerprint)` | Public custody + cold-chain verification |

## Transaction Signing Flow

```
1. User clicks action (e.g. "Mint NFT")
2. App calls OData action        > { unsignedCbor, buildId }
3. App calls wallet.signTx(cbor) > browser wallet popup
4. User confirms                 > signedCbor
5. App calls SubmitSigned        > { txHash, status: "SUBMITTED" }
6. Background polling (30s)      > status: "CONFIRMED" | "FAILED"
```

TRACE/ODATANO never hold private keys. All signing happens in the user's browser wallet.

## UI Pages

| Page | Description |
|------|-------------|
| Batches | List batches with status chips, create DRAFT batches |
| Batch Detail | Mint/Transfer/Anchor actions, event timeline, asset info |
| Participants | Inline CRUD table |
| Verify | Public verification of batch custody chain |
