// Ad-hoc verification: does Pebble's `int as bytes` produce minimal big-endian
// (matching Aiken's int_to_bytes) or the 0.1.6-era 4*n bytes?
// Compiles a tiny probe contract and runs it on the plutus-machine.

import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";
import { fileURLToPath } from "node:url";
import { UPLCDecoder, Application, UPLCConst } from "@harmoniclabs/uplc";
import { Machine } from "@harmoniclabs/plutus-machine";
import { DataConstr, DataB } from "@harmoniclabs/plutus-data";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.join(root, "src/index.pebble");
const hex = path.join(root, "out/script.hex");

const orig = fs.readFileSync(src, "utf8");

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

function probe(n, expectedLen) {
    fs.writeFileSync(src, `contract P { mint test() { const b = ${n} as bytes; assert b.length() == ${expectedLen}; } }`, "utf8");
    cp.execSync("node scripts/compile.js", { cwd: root, stdio: "ignore" });
    cp.execSync("node scripts/flat-to-cbor.js", { cwd: root, stdio: "ignore" });
    const inner = cborUnwrap(cborUnwrap(Buffer.from(fs.readFileSync(hex, "utf8").trim(), "hex")));
    const program = new UPLCDecoder(inner).decodeProgram();
    const applied = new Application(program.body, UPLCConst.data(ctx));
    try {
        const r = Machine.evalSimple(applied);
        return r?.constructor?.name === "CEKConst";
    } catch { return false; }
}

try {
    console.log("Testing minimal big-endian (Aiken int_to_bytes semantics):");
    for (const [n, len] of [[0, 0], [1, 1], [2, 1], [127, 1], [256, 2], [258, 2]]) {
        const ok = probe(n, len);
        console.log(`  ${n} as bytes → length ${len}: ${ok ? "PASS (minimal — bug FIXED)" : "fail"}`);
    }
    console.log("\nTesting legacy 4*n bytes (Pebble 0.1.6 bug):");
    for (const [n, len] of [[1, 4], [2, 8], [127, 508]]) {
        const ok = probe(n, len);
        console.log(`  ${n} as bytes → length ${len}: ${ok ? "PASS (bug still present)" : "fail (bug not present)"}`);
    }
} finally {
    fs.writeFileSync(src, orig, "utf8");
}
