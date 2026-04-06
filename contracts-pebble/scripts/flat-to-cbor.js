// Convert Pebble .flat output to double-CBOR-wrapped hex for ODATANO
// ODATANO expects: hex(CBOR(CBOR(flat_bytes))) — the standard Plutus script format

import * as fs from "node:fs";
import * as path from "node:path";

const flatPath = path.resolve(process.cwd(), "out/out.flat");
const outPath = path.resolve(process.cwd(), "out/script.hex");

if (!fs.existsSync(flatPath)) {
    console.error("out/out.flat not found. Run 'node scripts/compile.js' first.");
    process.exit(1);
}

const flatBytes = fs.readFileSync(flatPath);

// CBOR encode bytes: major type 2 (byte string)
function cborEncodeBytes(buf) {
    const len = buf.length;
    if (len < 24) {
        return Buffer.concat([Buffer.from([0x40 | len]), buf]);
    } else if (len < 256) {
        return Buffer.concat([Buffer.from([0x58, len]), buf]);
    } else if (len < 65536) {
        const hdr = Buffer.alloc(3);
        hdr[0] = 0x59;
        hdr.writeUInt16BE(len, 1);
        return Buffer.concat([hdr, buf]);
    } else {
        const hdr = Buffer.alloc(5);
        hdr[0] = 0x5a;
        hdr.writeUInt32BE(len, 1);
        return Buffer.concat([hdr, buf]);
    }
}

// Double-CBOR wrap: CBOR(CBOR(flat_bytes))
const innerCbor = cborEncodeBytes(flatBytes);
const outerCbor = cborEncodeBytes(innerCbor);
const hex = outerCbor.toString("hex");

fs.writeFileSync(outPath, hex, "utf8");

console.log(`Flat bytes:  ${flatBytes.length} bytes`);
console.log(`Inner CBOR:  ${innerCbor.length} bytes`);
console.log(`Outer CBOR:  ${outerCbor.length} bytes`);
console.log(`Script hex:  ${hex.length} chars`);
console.log(`Written to:  out/script.hex`);
console.log();
console.log("Use this hex as 'mintingPolicyScript' or 'validatorScript' in ODATANO.");
