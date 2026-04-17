// Probe: does Pebble's C-style `for(init; cond; update) { ... }` propagate
// `let` mutations to the outer scope? (The `for-of` form does NOT — see
// docs/pebble-this-param-in-spend-bug.md / incrementCounter notes.)

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

function probe(body, expected) {
    fs.writeFileSync(src, `contract P { mint test() { ${body} assert result == ${expected}; } }`, "utf8");
    cp.execSync("node scripts/compile.js", { cwd: root, stdio: "ignore" });
    cp.execSync("node scripts/flat-to-cbor.js", { cwd: root, stdio: "ignore" });
    const inner = cborUnwrap(cborUnwrap(Buffer.from(fs.readFileSync(hex, "utf8").trim(), "hex")));
    const program = new UPLCDecoder(inner).decodeProgram();
    const applied = new Application(program.body, UPLCConst.data(ctx));
    try {
        return Machine.evalSimple(applied)?.constructor?.name === "CEKConst";
    } catch { return false; }
}

try {
    // Baseline — no mutation, just an expression (sanity that probe harness works).
    console.log("1. `let result = 5;`                           expect 5:", probe("let result = 5;", 5) ? "PASS" : "FAIL");

    // C-style for(;;) with accumulator — does mutation propagate?
    console.log("2. `for(let i=0;i<3;i+=1){result+=1}`         expect 3:",
        probe("let result = 0; for( let i = 0; i < 3; i = i + 1 ) { result = result + 1; }", 3) ? "PASS" : "FAIL");

    // for-of with accumulator (KNOWN BUG — expect 0, not 3).
    console.log("3. `for(const x of [1,2,3]){result+=1}`        expect 0:",
        probe("let result = 0; for( const x of [1,2,3] ) { result = result + 1; }", 0) ? "PASS (bug confirmed — stays 0)" : "fail");
    console.log("   same test                                   expect 3:",
        probe("let result = 0; for( const x of [1,2,3] ) { result = result + 1; }", 3) ? "PASS (bug fixed!)" : "FAIL (stuck at 0)");
} finally {
    fs.writeFileSync(src, orig, "utf8");
}
