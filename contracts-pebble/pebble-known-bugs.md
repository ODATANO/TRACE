# Pebble Known Bugs

Three bugs in `@harmoniclabs/pebble` 0.1.8 shape the TRACE Pebble port
(`contracts-pebble/src/index.pebble`). Each has a minimal repro from this
repo and a local workaround. File upstream at
`https://github.com/HarmonicLabs/pebble` once confirmed against a fresh
clone.

The separately tracked `int as bytes` issue is already fixed in 0.1.8 — see
[`pebble-int-to-bytes-bug.md`](./pebble-int-to-bytes-bug.md).

## Bug A — triple-check on same `TxOut` silently rejects

**Symptom**: reading `.address` + `.value` AND destructuring `.datum` on the
same `TxOut` binding within one block evaluates to Error (silent REJECT).
Any pair of the three passes; all three together fails.

**Minimal pattern**:
```pebble
const out = outputs.head();
assert out.address.payment.hash() == ownHash;
assert out.value.amountOf(ownHash, name) == 1;
const InlineDatum{ datum: ChainOfCustody{ ... } } = out.datum;   // REJECT
```

**Workaround**: top-level destructure of the three fields at once.
```pebble
const { address, value, datum } = out;
assert address.payment.hash() == ownHash;
assert value.amountOf(ownHash, name) == 1;
const InlineDatum{ datum: ChainOfCustody{ ... } } = datum;       // OK
```

Used in `incrementCounter` for both the per-batch output (inside the loop)
and the counter output (`tx.outputs[0]`).

## Bug B — `this.<param>` in any method body produces `cannot force Error`

**Symptom**: reading a contract parameter via `this.<name>` inside a method
body (spend or mint, with or without a redeemer parameter) evaluates to
`NonPolymorphicInstantiation: cannot force Error`. Rebinding to a local
const doesn't help. Hardcoded byte literals work.

Exception: `this.seed` works *when used as an equality argument in a list
predicate* (`tx.inputs.some(({ref}) => ref == this.seed)`). That specific
form evidently hits a different codegen path.

**Minimal pattern**:
```pebble
mint probe() {
    const { tx } = context;
    assert tx.requiredSigners.includes(this.manufacturer);    // REJECT
}
```

**Repro — tested in this session**: replacing `this.manufacturer` with a
hardcoded 28-byte literal makes the same test ACCEPT.

**Workaround**: hoist the parameter into an on-chain datum field and source
it from there. For `pharma_trace` we added `manufacturer: PubKeyHash` to the
`MintCounter` struct — the spend endpoint reads `mfr` from the datum
destructure instead of touching `this.manufacturer`.

Security trade-off: the datum field is user-controllable at init time. We
anchor authenticity in **seed control** instead (the validator is
parameterised by a one-shot `OutputReference`, which only the real
manufacturer controls). See comment at
`contracts/validators/pharma_trace.ak:91-127` (`can_init_counter`).

## Bug A.2 — expression-position `as bytes` inside a loop

**Symptom**: an inline `(expr) as bytes` conversion used directly as an
assertion argument inside a for-body silently rejects in multi-iteration
cases.

**Minimal pattern**:
```pebble
for( let i = 0; i < total; i = i + 1 ) {
    const batch_name = (prevCounter + i + 1) as bytes;     // REJECT on 3+ batches
    // ...
}
```

**Workaround**: bind the integer to an intermediate `const` first, then
convert.
```pebble
for( let i = 0; i < total; i = i + 1 ) {
    const batchIdx = prevCounter + i + 1;
    const batch_name = batchIdx as bytes;                  // OK
    // ...
}
```

Possibly a specialisation of Bug A (expression-position values
re-evaluated per access) interacting with the V3
`integerToByteString` builtin, but not confirmed.

## Bug C — `let` mutations don't propagate out of loops

**Symptom**: mutating an outer `let` variable inside either a `for-of` loop
**or** a C-style `for(init; cond; update)` loop — when combined with other
`let` mutations in the same body — leaves the outer scope's variable at its
initial value.

A simple isolated probe (single `let` mutation in C-style `for`) DOES
propagate (see `scripts/probe-cstyle-for-mutation.mjs`). The failure surfaces
in loops that also mutate other `let`s (e.g. `remaining = remaining.tail()`
while updating a counter).

**Minimal pattern** (inside `incrementCounter`, prior to workaround):
```pebble
let nextCounter = prevCounter;
let remaining = tx.mint[ownHash];
for( let i = 0; i < total; i = i + 1 ) {
    nextCounter = nextCounter + 1;
    remaining = remaining.tail();
}
// nextCounter still equals prevCounter here (should be prevCounter + total)
```

**Workaround**: avoid reading mutated `let`s after the loop. Compute any
value needed post-loop via functional expression. Example from TRACE:
```pebble
const total = mints.length();
const nextCounter = prevCounter + total;    // no let, no mutation across scope
let remainingMints = mints;                 // loop-local bookkeeping only
for( let i = 0; i < total; i = i + 1 ) {
    // read remainingMints, assert, advance .tail()
}
```

See `contracts-pebble/src/index.pebble` `incrementCounter` body for the
full pattern.

## Verification

All workarounds are covered by the differential equivalence harness —
`contracts-pebble/scripts/diff-equiv.mjs` runs both validators against
identical Plutus V3 ScriptContexts and confirms matching accept/reject
outcomes. 14/14 tests pass at time of writing.

Regression guard for Bug C specifically: the
`incrementCounter accepts 3 new batches` test exercises the multi-iteration
loop path; without the functional-counter workaround, it would fail where
the single-batch test might not.
