# TRACE Smart Contracts

Plutus v3 validators for the TRACE pharmaceutical supply chain, written in [Aiken](https://aiken-lang.org).

## Overview

The `pharma_trace` validator enforces on-chain custody tracking for pharmaceutical batches. Each batch is represented by a unique NFT that carries a `ChainOfCustody` datum as it moves through the supply chain.

### Data Types

**ChainOfCustody** (inline datum on the NFT UTxO):

| Field            | Type                  | Description                              |
|------------------|-----------------------|------------------------------------------|
| `manufacturer`   | `VerificationKeyHash` | Original manufacturer (immutable)        |
| `current_holder` | `VerificationKeyHash` | Current custodian of the batch           |
| `batch_id`       | `ByteArray`           | Unique batch identifier                  |
| `step`           | `Int`                 | Transfer counter (increments each hop)   |

**Action** (redeemer for spend):

| Variant    | Field         | Description                   |
|------------|---------------|-------------------------------|
| `Transfer` | `next_holder` | Key hash of the next custodian |

### Validator Logic

The `pharma_trace` validator is **parameterized** by the manufacturer's `VerificationKeyHash`. This means the compiled `plutus.json` contains unapplied code — the manufacturer parameter is applied at runtime via ODATANO's `scriptParamsJson`, which produces a unique policy ID per manufacturer.

**`mint`** — Minting a batch NFT:
- The manufacturer must sign the transaction (`extra_signatories` check)
- Exactly one token must be minted under this policy ID

**`spend`** — Transferring custody:
- The current holder must sign the transaction
- A continuing output must exist with an updated `ChainOfCustody` where:
  - `manufacturer` is unchanged
  - `current_holder` is set to the redeemer's `next_holder`
  - `batch_id` is unchanged
  - `step` is incremented by 1

**`else`** — All other purposes (e.g. withdraw, publish) are rejected.

## Building

Requires [Aiken](https://aiken-lang.org/installation-instructions) v1.1.21+.

```sh
cd contracts
aiken build
```

This produces `plutus.json` containing the compiled UPLC for all three validator endpoints (`mint`, `spend`, `else`).

## Testing

```sh
aiken check
```

## Integration with TRACE

The compiled validators are consumed by `srv/lib/chain-adapter.ts`, which reads `plutus.json` and passes the unapplied script hex to ODATANO's transaction-building actions:

- **Minting**: `BuildMintTransaction` with `scriptParamsJson` (applies manufacturer param), `inlineDatumJson` (attaches `ChainOfCustody`), and `requiredSignersJson`
- **Transfer**: `BuildPlutusSpendTransaction` with the applied spend validator, redeemer (`Transfer { next_holder }`), and updated inline datum on the continuing output

See the [ODATANO integration docs](../.claude/rules/odatano.md) for full details on the transaction flow.

## Project Config

- **Compiler**: Aiken v1.1.21
- **Plutus version**: v3
- **Dependency**: aiken-lang/stdlib v3.0.0
- **License**: Apache-2.0
