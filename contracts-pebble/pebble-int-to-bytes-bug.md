# Pebble: `int as bytes` produces `4 * n` bytes

> **STATUS — fixed upstream in `@harmoniclabs/pebble` 0.1.8.**
> `hoisted_intToBytesBE` now compiles to `integerToByteString(true, 0, n)` (size = 0 → minimal big-endian), matching Aiken's `int_to_bytes`. The buggy `hoisted_sizeofPositiveInt` path is commented out at `dist/IR/toUPLC/subRoutines/replaceNatives/nativeToIR.js:227-244`.
>
> Empirically verified via `contracts-pebble/scripts/probe-int-to-bytes.mjs`: 0→0, 1→1, 2→1, 127→1, 256→2, 258→2 bytes. The legacy 4×n outputs (1→4, 2→8, 127→508) no longer occur.
>
> The historical analysis below is preserved for context.

**Package**: `@harmoniclabs/pebble` 0.1.6
**Pattern**: `len(n as bytes) == 4 * max(n, 1)` — output length scales with the integer's value, not its bit-width.

## Observed output

Empirically verified via `@harmoniclabs/plutus-machine`:

| Input | Pebble output | Minimal big-endian |
|---|---|---|
| `0 as bytes`   | 4 bytes (`0x00000000`)             | 0 bytes (`#""`) |
| `1 as bytes`   | 4 bytes (`0x00000001`)             | 1 byte (`0x01`) |
| `2 as bytes`   | 8 bytes (`0x0000000000000002`)     | 1 byte (`0x02`) |
| `3 as bytes`   | 12 bytes                            | 1 byte |
| `10 as bytes`  | 40 bytes                            | 1 byte |
| `127 as bytes` | 508 bytes                           | 1 byte |

## Source

`node_modules/@harmoniclabs/pebble/dist/IR/toUPLC/subRoutines/replaceNatives/nativeToIR.js:107` (`hoisted_sizeofPositiveInt`) and `:233` (`hoisted_intToBytesBE`).

`hoisted_intToBytesBE` calls `integerToByteString(true, sizeofPositiveInt(n), n)`. `hoisted_sizeofPositiveInt` is constructed as `_ir_apps(IRRecursive(λ(sizeof_n, sizeof_countWords). body), IRConst.int(0))` — the partial application places `0` in the first parameter (`sizeof_n`), so the body's `n != 0` recursive branch is unreachable and the function always returns `4 * countWords` (or `4` when `countWords == 0`).

## Reproduction

Minimal Pebble contract:

```pebble
contract Probe {
    mint test() {
        const b = 1 as bytes;
        assert b.length() == 1;   // FAILS — Pebble produces 4 bytes
    }
}
```

Harness (Node, ESM):

```js
import * as fs from "node:fs";
import * as cp from "node:child_process";
import { UPLCDecoder, Application, UPLCConst } from "@harmoniclabs/uplc";
import { Machine } from "@harmoniclabs/plutus-machine";
import { DataConstr, DataB } from "@harmoniclabs/plutus-data";

const ctx = new DataConstr(0n, [
    new DataConstr(0n, []),
    new DataConstr(0n, []),
    new DataConstr(0n, [new DataB(Buffer.alloc(28, 0))])
]);

function cborUnwrap(buf) {
    const info = buf[0] & 0x1f;
    let len, off;
    if (info < 24) { len = info; off = 1; }
    else if (info === 24) { len = buf[1]; off = 2; }
    else if (info === 25) { len = buf.readUInt16BE(1); off = 3; }
    else if (info === 26) { len = buf.readUInt32BE(1); off = 5; }
    return buf.slice(off, off + len);
}

function test(n, expectedLen) {
    const src = `contract P { mint test() { const b = ${n} as bytes; assert b.length() == ${expectedLen}; } }`;
    fs.writeFileSync("src/index.pebble", src, "utf8");
    cp.execSync("node scripts/compile.js", { stdio: "ignore" });
    cp.execSync("node scripts/flat-to-cbor.js", { stdio: "ignore" });
    const inner = cborUnwrap(cborUnwrap(
        Buffer.from(fs.readFileSync("out/script.hex", "utf8").trim(), "hex")
    ));
    const program = new UPLCDecoder(inner).decodeProgram();
    const applied = new Application(program.body, UPLCConst.data(ctx));
    try {
        const r = Machine.evalSimple(applied);
        return r?.constructor?.name === "CEKConst";
    } catch { return false; }
}

for (const n of [1, 3, 10, 127]) {
    console.log(`len(${n} as bytes) == ${4 * n}: ${test(n, 4 * n) ? "PASS" : "fail"}`);
}
```

All four print `PASS`.

## Environment

- `@harmoniclabs/pebble` 0.1.6, `@harmoniclabs/pebble-cli` 0.1.0
- `@harmoniclabs/plutus-machine` 3.x, `@harmoniclabs/uplc` (bundled)
- Plutus V3 / UPLC 1.1.0
- Node.js 22.11.0
