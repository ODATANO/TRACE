# Differential Equivalence: Aiken vs Pebble pharma_trace

Reproduce: `cd contracts-pebble && node scripts/diff-equiv.mjs`

Both validators (`contracts/validators/pharma_trace.ak` and `contracts-pebble/src/index.pebble`) implement the counter-pattern state machine. The harness builds Plutus V3 ScriptContexts by hand, evaluates both compiled scripts against the same context with `@harmoniclabs/plutus-machine`, and compares accept/reject outcomes.

## Setup

- Aiken script: from `contracts/plutus.json` (mint endpoint).
- Pebble script: built via `scripts/compile-fork.js` (pebble-fork with the `int as bytes` patch — see `pebble-int-to-bytes-bug.md`).
- Params: `manufacturer` VKH + `seed` `OutputReference`, applied identically to both.
- Mint redeemer Constr indices differ: Pebble source order (`mintBatch=0`, `initCounter=1`, `burn=2`) vs Aiken `MintAction` (`InitCounter=0`, `MintBatch=1`, `Burn=2`). Spend endpoints align. The harness builds the right redeemer per validator.

## Result

```
Test                                                   | Aiken    | Pebble   | Expected | Match
---------------------------------------------------------------------------------------------------------
burn accepts negative qty                              | ACCEPT   | ACCEPT   | ACCEPT   | OK
burn rejects positive qty                              | REJECT   | REJECT   | REJECT   | OK
initCounter accepts valid seed-spend + counter mint    | ACCEPT   | ACCEPT   | ACCEPT   | OK
initCounter rejects without seed                       | REJECT   | REJECT   | REJECT   | OK
mintBatch accepts when counter is at given index       | ACCEPT   | ACCEPT   | ACCEPT   | OK
mintBatch rejects when input at idx is wallet          | REJECT   | REJECT   | REJECT   | OK
deliver accepts with current_holder signature          | ACCEPT   | ACCEPT   | ACCEPT   | OK
deliver rejects without holder signature               | REJECT   | REJECT   | REJECT   | OK
transfer accepts valid step+1 continuing output        | ACCEPT   | ACCEPT   | ACCEPT   | OK
transfer rejects when step not incremented             | REJECT   | REJECT   | REJECT   | OK
incrementCounter accepts single new batch              | ACCEPT   | REJECT   | ACCEPT   | MISMATCH
incrementCounter rejects without manufacturer signature | REJECT   | REJECT   | REJECT   | OK

11/12 passed, 1 mismatch
```

## The mismatch — `incrementCounter accepts single new batch`

Pebble rejects with `NonPolymorphicInstantiation: cannot force Error` (the standard runtime signature of an `assert` failure path).

### Bisection

| Probe variant of `incrementCounter` | Pebble |
|---|---|
| Loop body asserts replaced with `assert nextCounter == 1`                                 | ACCEPT |
| Loop body asserts replaced with `assert nextCounter == 0`                                 | REJECT |
| Empty loop body, full post-loop counter check                                              | REJECT |
| Post-loop check minus the two field-asserts (just destructure + counter compare)          | ACCEPT |
| Only `nextCounterUtxo.address.payment.hash() == ownHash` + destructure                    | ACCEPT |
| Only `nextCounterUtxo.value.amountOf(...) == 1` + destructure                              | ACCEPT |
| `address.payment.hash()` + `value.amountOf(...)`, no destructure                           | ACCEPT |
| `address.payment.hash()` + `value.amountOf(...)` + `.datum` destructure (original)        | REJECT |

The failing combination is all three of:

1. `nextCounterUtxo.address.payment.hash() == ownHash`
2. `nextCounterUtxo.value.amountOf( ownHash, # ) == 1`
3. `const InlineDatum{ datum: MintCounter{ n: next } as ContractDatum } = nextCounterUtxo.datum`

Each pair works. Removing any one element makes the test pass.

