# TRACE Smart Contracts

On-chain validators for the **TRACE** pharmaceutical supply chain. Two
independent implementations of the same logic live side by side:

| Folder | Language | Role |
|--------|----------|------|
| [`contracts-aiken/`](./contracts-aiken) | [Aiken](https://aiken-lang.org) → Plutus V3 | **Canonical on-chain source of truth.** Compiles to `plutus.json`, which the off-chain service (`srv/lib/chain-adapter.ts`) loads and deploys. |
| [`contracts-pebble/`](./contracts-pebble) | [Pebble](https://github.com/HarmonicLabs/pebble) → UPLC | **Differential cross-check.** A second, independent port used to verify the Aiken logic by differential equivalence. Not deployed. |

The two implementations are kept behaviourally equivalent and verified against
each other (see [Differential equivalence](#differential-equivalence)). When the
two disagree on an edge case, **Aiken is authoritative** — it is the code that
actually runs on-chain.

There are two validators, each shipped in both languages:

1. **`pharma_trace`** — batch custody tracking (mint + chain-of-custody transfer).
2. **`cold_chain`** — condition (cold-chain) monitoring per batch/shipment.

---

## 1. `pharma_trace` — batch custody

Each pharmaceutical batch is a unique NFT minted under a **per-manufacturer
policy id**. The validator is parameterized by the manufacturer's
`VerificationKeyHash` and a one-shot `seed` UTxO reference, so every manufacturer
gets a distinct, cryptographically bound policy id.

A monotonic **counter NFT** (empty asset name) lives at the script and is
spent + re-created each time a new batch is minted, guaranteeing
gap-free, sequential batch numbering.

### Datum — `ContractDatum`

`ChainOfCustody` travels with each batch NFT:

| Field            | Type                  | Description                            |
|------------------|-----------------------|----------------------------------------|
| `manufacturer`   | `VerificationKeyHash` | Original manufacturer (immutable)      |
| `current_holder` | `VerificationKeyHash` | Current custodian                      |
| `batch_id`       | `ByteArray`           | Batch identifier (= the NFT name)      |
| `step`           | `Int`                 | Transfer hop counter (+1 per transfer) |

`MintCounter { n: Int }` is carried by the counter NFT and stores only the
running index. The manufacturer identity is *not* replicated in the datum — it is
bound by the parameterized script hash.

### Redeemers

| Purpose | Constr | Variant            | Effect |
|---------|:------:|--------------------|--------|
| Mint    | 0      | `InitCounter`      | Bootstrap: consume the `seed`, mint the counter NFT (`n = 0`) at output 0. |
| Mint    | 1      | `MintBatch { counter_input_idx }` | Mint exactly one batch NFT; delegates full checks to the counter spend. |
| Mint    | 2      | `Burn`             | Burn tokens under this policy (all quantities negative). |
| Spend   | 0      | `Transfer { input_idx, output_idx }` | Hand custody to the next holder; current holder signs, `step` +1, batch & manufacturer unchanged, NFT preserved at script. |
| Spend   | 1      | `Deliver`          | NFT leaves the script to the holder's wallet; current holder signs. No continuing output. |
| Spend   | 2      | `IncrementCounter { own_input_idx }` | Atomic counter spend + single batch mint: output 0 = counter (`n+1`), output 1 = new batch NFT at `step 0`. Manufacturer signs. |

> Single-batch-per-tx: under Pebble 0.3.x `Value` is opaque (no token
> enumeration), so both validators mint exactly **one** batch per transaction and
> check it by name (`int_to_bytes(n+1)`).

---

## 2. `cold_chain` — condition monitoring

Companion validator (does **not** touch `pharma_trace`). Manages one monitoring
**thread NFT** per batch/shipment leg that accumulates tamper-evident sensor
attestations. Parameterized by an `oracle` VKH and a one-shot `seed`.

**Design — commit-on-chain / prove-off-chain.** Individual temperature/humidity
readings stay off-chain; on-chain we keep a 32-byte running commitment
(`commit_root`) plus monotonic counters. The validator enforces the integrity
properties that make the log trustworthy without paying for one tx per reading:

1. only the authorised oracle may append readings (signature),
2. `reading_count` is strictly monotonic — no silent dropping of readings,
3. `breach_count` is monotonic — excursions cannot be un-counted,
4. `breached` latches `0 → 1`, never back — an excursion can never be hidden,
5. `oracle` / `batch_id` / spec-range are immutable for the monitor lifetime,
6. the thread NFT stays at the script — history cannot be forked.

### Datum — `MonitorDatum` (`MonitorState`)

| Field           | Type        | Description |
|-----------------|-------------|-------------|
| `batch_id`      | `ByteArray` | Batch / shipment identifier |
| `min_milli_c`   | `Int`       | Lower spec bound, signed milli-°C (fridge `2000`, freezer `-25000`) |
| `max_milli_c`   | `Int`       | Upper spec bound, signed milli-°C |
| `reading_count` | `Int`       | Readings committed so far (strictly monotonic) |
| `breach_count`  | `Int`       | Out-of-spec readings so far (monotonic) |
| `commit_root`   | `ByteArray` | 32-byte commitment to the off-chain reading log |
| `breached`      | `Int`       | `0` = clean, `1` = excursion (latched) |

### Redeemers

| Purpose | Constr | Variant              | Effect |
|---------|:------:|----------------------|--------|
| Mint    | 0      | `InitMonitor`        | Consume `seed`, mint the thread NFT, lock a zeroed `MonitorState` at output 0. |
| Mint    | 1      | `BurnMonitor`        | Burn the thread token (negative quantity). |
| Spend   | 0      | `RecordReadings { input_idx, output_idx }` | Append a batch of readings: oracle signs, counts advance, breach latches, immutable fields & NFT preserved. |
| Spend   | 1      | `Close`              | Finalise (e.g. at delivery); oracle signs. NFT may then leave / be burned. |

---

## Canonical ABI

Both languages **must** agree on these Constr indices. Pebble assigns indices by
declaration order, so methods/variants must not be reordered without updating
both files **and** the off-chain (`srv/lib/chain-adapter.ts`).

```
pharma_trace
  Mint:  InitCounter=0   MintBatch=1   Burn=2
  Spend: Transfer=0      Deliver=1     IncrementCounter=2
  Datum: ChainOfCustody=0  MintCounter=1

cold_chain
  Mint:  InitMonitor=0    BurnMonitor=1
  Spend: RecordReadings=0  Close=1
  Datum: MonitorState=0
```

---

## Building & testing

### Aiken (canonical — produces the deployed artifact)

Requires [Aiken](https://aiken-lang.org/installation-instructions) **v1.1.21**.

```sh
cd contracts/contracts-aiken
aiken check    # run the on-chain unit tests
aiken build    # regenerate plutus.json
```

`plutus.json` contains the unapplied (parameterized) UPLC for every endpoint of
both validators. CI fails if a commit's `plutus.json` is out of sync with the
sources.

### Pebble (cross-check — not deployed)

```sh
cd contracts/contracts-pebble
npm install
npm run compile            # compile pharma_trace -> out/
npm run compile:coldchain  # compile cold_chain  -> out-coldchain/
```

---

## Differential equivalence

The Pebble port exists to **independently re-derive** the Aiken logic and prove
the two produce identical accept/reject decisions on the same Plutus V3
`ScriptContext`s. The diff harness evaluates both compiled programs with
`@harmoniclabs/plutus-machine`:

```sh
cd contracts/contracts-pebble
npm run diff:pharma      # build pharma_trace + differential check
npm run diff:coldchain   # build cold_chain  + differential check
npm run diff             # both
```

**Documented divergence:** under Pebble 0.3.x `Value` is an opaque native (no
token enumeration — `amountOf(policy, name)` only). The Pebble port therefore
cannot express Aiken's strict "exactly one token under the policy" check; it
asserts only the named token. Aiken keeps the strict invariant and remains the
on-chain authority.

---

## Off-chain integration

`srv/lib/chain-adapter.ts` reads `contracts/contracts-aiken/plutus.json` and
drives the deployment through ODATANO's transaction-building actions. It looks
validators up by title:

| Title | Used for |
|-------|----------|
| `pharma_trace.pharma_trace.mint`  | `InitCounter`, `MintBatch`, `Burn` |
| `pharma_trace.pharma_trace.spend` | `Transfer`, `Deliver`, `IncrementCounter` |
| `cold_chain.cold_chain.mint`      | `InitMonitor`, `BurnMonitor` |
| `cold_chain.cold_chain.spend`     | `RecordReadings`, `Close` |

The unapplied script hex is passed as-is to `BuildMintTransaction` /
`BuildPlutusSpendTransaction`, with the manufacturer/oracle + seed supplied via
`scriptParamsJson` (producing the per-issuer policy id), `inlineDatumJson` for
the datum, `requiredSignersJson` for the `extra_signatories` checks, and the
matching redeemer. See [`../.claude/rules/odatano.md`](../.claude/rules/odatano.md)
for the full Build → Sign → Submit flow.

> **CBOR note:** the script hex from the compilers is already CBOR-wrapped flat
> UPLC. Pass it as-is — do **not** unwrap the outer CBOR layer, or the hash (and
> therefore the script address) changes and funds become unspendable.

---

## Config & license

- **Aiken:** compiler v1.1.21, Plutus V3, `aiken-lang/stdlib` v3.0.0
- **Pebble:** `@harmoniclabs/pebble` `^0.3.4`
- **License:** Apache-2.0 (funded by Cardano Catalyst Fund 14)
