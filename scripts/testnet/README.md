# Cold-chain testnet run (preview)

End-to-end validation of the cold-chain flow **on a real Cardano preview
network** via ODATANO/Buildooor. Everything else in the repo is tested with a
mocked `chain-adapter`; this is the only path that proves the transactions
actually **build, sign, submit and validate on-chain**.

> ⚠️ Authored without a funded wallet — **this has not been run yet**. Treat the
> first execution as the validation itself. The likely-to-break spots are
> flagged under "Risk areas" below.

## What it does

`coldchain-e2e.mjs` drives a live `TraceService`:

1. **InitColdChainMonitor** (fridge spec 2–8 °C) → sign → submit → poll `CONFIRMED`
2. **RecordSensorReadings** (in-spec) → sign → submit → poll `readingCount ≥ 2`
3. **RecordSensorReadings** (breach, 15 °C) → sign → submit → poll `breached = true`
4. **VerifyBatch** → assert `coldChain.breached === true` and `isValid === false`
5. **CloseColdChainMonitor** → sign → submit → poll `CLOSED`

It also exercises **auto-quarantine** (the breach moves the batch to `QUARANTINE`,
observable via `GET /Batches(<id>)`).

## Prerequisites

1. **A funded preview wallet.** Get test ADA from the
   [preview faucet](https://docs.cardano.org/cardano-testnets/tools/faucet). You
   need a few pure-ADA UTxOs (each on-chain step locks ~2.5 ADA + fees + the
   one-shot seed UTxO for the monitor mint).
2. **Wallet address + verification key hash + signing key.**
   - `WALLET_ADDRESS` — bech32 `addr_test1…`
   - `WALLET_VKH` — 28-byte hex payment key hash
   - `WALLET_SKEY_HEX` — 32-byte ed25519 **seed** (hex). The derived pubkey hash
     must equal `WALLET_VKH`. *(Only needed for a real submit; omit for `--dry-run`.)*
3. **A Blockfrost preview key** (or Koios) for ODATANO.
4. **A confirmed, minted batch** to monitor. The monitor binds to the batch's
   on-chain asset name, so mint one first (see "Mint a batch" below) and pass its
   id as `BATCH_ID`.

## Configure & start the server

In the consumer `package.json` (`cds.requires.odatano-core`):

```json
{ "network": "preview", "backends": ["blockfrost"], "blockfrostApiKey": "preview_…" }
```

Then run the service (dummy auth in the dev profile = no auth header needed):

```bash
cds watch          # serves at http://localhost:4004
```

## Mint a batch first (one-time, manual)

The driver assumes a minted batch. Bootstrap it once (same build→sign→submit
pattern — do it through the UI/CIP-30 wallet, or extend the driver):

1. `InitManufacturerCounter` → sign → submit → wait `CONFIRMED`
2. Create a batch: `POST /odata/v4/trace/Batches { "batchNumber":"LOT-1", "product":"Vaccine", "status":"DRAFT" }`
3. `MintBatchNft { batchId, walletAddress, walletVkh }` → sign → submit → wait `CONFIRMED`

Copy the batch id into `BATCH_ID`.

## Run

```bash
# Validate the builds only (no signing/submit; needs a funded address for UTxOs):
WALLET_ADDRESS=addr_test1… WALLET_VKH=<hex> BATCH_ID=<uuid> \
  node scripts/testnet/coldchain-e2e.mjs --dry-run

# Full on-chain flow:
WALLET_ADDRESS=addr_test1… WALLET_VKH=<hex> WALLET_SKEY_HEX=<32b-hex> BATCH_ID=<uuid> \
  node scripts/testnet/coldchain-e2e.mjs
```

Optional env: `TRACE_BASE_URL` (default `http://localhost:4004`),
`AUTH_HEADER`, `POLL_TIMEOUT_MS` (default 180000).

Exit code `0` = full flow confirmed on-chain; non-zero = a step failed (message
printed).

## Risk areas to watch (mock vs. real chain)

These are the assumptions the mocked tests can't prove — check them on the first run:

- **Output index assumptions.** The validator requires the monitor thread token
  at a fixed output position; `_applyConfirmationSideEffects` locates it via
  `getAssetOutputIndex(txHash, policyId, "")`. If ODATANO orders outputs
  differently than expected, confirmation will defer forever ("indexer lag").
- **Min-ADA inflation.** Inline datums + the thread token raise the min-ADA of
  the script output; if `lovelaceAmount` (2.5 ADA) is too low Buildooor will
  reject the build. Bump it if you see a min-ADA error.
- **Script-param order / policy id.** `buildColdChainParams` applies
  `(oracle, seed)`; a wrong order yields a different policy → the spend can't
  find its own token. Verify `policyId` is stable across init and record.
- **`__INPUT_IDX__` resolution.** `RecordReadings` passes the monitor UTxO as an
  `__INPUT_IDX:txHash#idx__` placeholder; confirm ODATANO resolves it to the
  post-coin-selection input position (Buildooor only).
- **Single-batch invariant.** `MintBatchNft` mints exactly one token; the
  validator now rejects multi-mint. Don't batch mints.
- **Witness format.** `signer.mjs` returns a bare `{0:[[vkey,sig]]}` witness set.
  If `SubmitVerifiedTransaction` rejects it, compare against what your CIP-30
  wallet returns and adjust (this is the most likely signing-side fix).
- **Indexer lag.** Confirmation polling re-runs `CheckPendingTransactions`; a
  freshly-submitted tx may take a few blocks to index. `POLL_TIMEOUT_MS`
  governs how long the driver waits.
