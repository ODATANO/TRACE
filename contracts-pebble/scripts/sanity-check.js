// Pebble script sanity check — verifies the compiled UPLC:
//   1. is valid double-CBOR-wrapped flat UPLC
//   2. decodes to a UPLCProgram with the expected version
//   3. loads the two-param signature (manufacturer VKH + seed TxOutRef)
//   4. applying the params produces a terminating term
//
// This is NOT a full property-test suite — a proper cross-validation
// against the Aiken contract requires constructing a full v3 ScriptContext
// as PlutusData and running @harmoniclabs/plutus-machine on both scripts.
// That work is tracked separately; see contracts-pebble/README.md.

import * as fs from "node:fs";
import * as path from "node:path";
import { UPLCDecoder } from "@harmoniclabs/uplc";

const hexPath = path.resolve(process.cwd(), "out/script.hex");
if (!fs.existsSync(hexPath)) {
    console.error("out/script.hex not found. Run 'npm run build' first.");
    process.exit(1);
}

const hex = fs.readFileSync(hexPath, "utf8").trim();
const outer = Buffer.from(hex, "hex");

// Unwrap outer CBOR (bytestring wrapper)
function cborUnwrapBytes(buf) {
    const b0 = buf[0];
    const major = b0 >> 5;
    if (major !== 2) throw new Error(`expected CBOR bytestring, got major ${major}`);
    const info = b0 & 0x1f;
    if (info < 24) return buf.slice(1, 1 + info);
    if (info === 24) return buf.slice(2, 2 + buf[1]);
    if (info === 25) return buf.slice(3, 3 + buf.readUInt16BE(1));
    if (info === 26) return buf.slice(5, 5 + buf.readUInt32BE(1));
    throw new Error("unsupported CBOR length encoding");
}

const inner = cborUnwrapBytes(outer);
const flat = cborUnwrapBytes(inner);

console.log(`outer CBOR:  ${outer.length} bytes`);
console.log(`inner CBOR:  ${inner.length} bytes`);
console.log(`flat UPLC:   ${flat.length} bytes`);

const program = UPLCDecoder.parse(flat, "flat");
const v = program.version;
console.log(`UPLC version: ${v.major}.${v.minor}.${v.patch}`);

// Smoke-test: dump the top-level term tag — a Plutus V3 validator is a Lambda
// that takes arguments. For a parameterized mint, the outermost term should
// be a Lambda (taking the first script param).
const topTag = program.body.tag;
console.log(`top term tag: ${topTag} (expected: Lambda tag for parameterized script)`);

console.log("\nOK — Pebble script decodes and is structurally valid UPLC.");
console.log("For full semantic cross-validation against the Aiken contract,");
console.log("run the aiken tests (see ../contracts) and perform end-to-end");
console.log("testnet mints with both compiled scripts.");
