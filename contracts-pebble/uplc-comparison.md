# UPLC Structural Comparison: Aiken vs Pebble pharma_trace

Reproduce: `cd contracts-pebble && node scripts/compare-uplc.mjs`

Both validators implement the counter-pattern state machine. Behavioural equivalence: see `differential-equivalence.md`. Pebble version requires the `int as bytes` patch (see `pebble-int-to-bytes-bug.md`).

## Headline metrics

| Metric                    | Aiken         | Pebble        | Pebble / Aiken |
|---------------------------|--------------:|--------------:|---------------:|
| CBOR size (bytes)         |         2 556 |         4 414 |          1.73× |
| Flat UPLC size (bytes)    |         2 553 |         4 408 |          1.73× |
| UPLC version              |         1.1.0 |         1.1.0 |              — |
| Total term nodes          |         2 482 |         4 461 |          1.80× |
| Max term depth            |           171 |           140 |          0.82× |

## Term-kind breakdown

| Term kind   | Aiken | Pebble | Pebble / Aiken |
|-------------|------:|-------:|---------------:|
| Application |   713 |  1 657 |          2.32× |
| Builtin     |   208 |    472 |          2.27× |
| Case        |   116 |    122 |          1.05× |
| Constr      |   116 |    119 |          1.03× |
| Delay       |   182 |    192 |          1.05× |
| ErrorUPLC   |    23 |     78 |          3.39× |
| Force       |   105 |    106 |          1.01× |
| Lambda      |   169 |    236 |          1.40× |
| UPLCConst   |    86 |    103 |          1.20× |
| UPLCVar     |   764 |  1 376 |          1.80× |

## Builtin usage (top entries)

| Builtin                      | Aiken | Pebble | Pebble / Aiken |
|------------------------------|------:|-------:|---------------:|
| `unConstrData`               |   100 |    243 |          2.43× |
| `equalsInteger`              |     6 |     74 |         12.33× |
| `unListData`                 |    11 |     45 |          4.09× |
| `unBData`                    |    22 |     25 |          1.14× |
| `unIData`                    |    21 |     22 |          1.05× |
| `equalsByteString`           |    11 |     26 |          2.36× |
| `unMapData`                  |    10 |     16 |          1.60× |
| `addInteger`                 |     4 |      2 |          0.50× |
| `bData`                      |     0 |      5 |              ∞ |
| `lessThanInteger`            |     2 |      2 |          1.00× |
| `equalsData`                 |     3 |      1 |          0.33× |
| `iData`                      |     3 |      0 |              0 |
| `lengthOfByteString`         |     1 |      1 |          1.00× |
| `lessThanEqualsByteString`   |     2 |      0 |              0 |
| `ifThenElse`                 |     1 |      1 |          1.00× |

## Script hashes (blake2b-224)

- Aiken (mint endpoint): `b13ab637b148b591…`
- Pebble: `062a532f6d1280e3…`

## Reproducibility

```bash
cd contracts && aiken build
cd ../contracts-pebble && node scripts/compile-fork.js && node scripts/flat-to-cbor.js
node scripts/compare-uplc.mjs
```
