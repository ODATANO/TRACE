// Structural UPLC comparison: Aiken pharma_trace vs Pebble PharmaTrace.
// Reports script size, UPLC version, term/builtin statistics, and
// applied-script hashes for each.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { UPLCDecoder, UPLCBuiltinTag } from "@harmoniclabs/uplc";
import { DataConstr, DataI, DataB } from "@harmoniclabs/plutus-data";
import { blake2b_224 } from "@harmoniclabs/crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const traceRoot = path.resolve(__dirname, "../..");

// ---------- script loaders ----------

function loadAikenValidator(title) {
    const blueprint = JSON.parse(
        fs.readFileSync(path.join(traceRoot, "contracts/plutus.json"), "utf8")
    );
    const v = blueprint.validators.find(x => x.title === title);
    if (!v) throw new Error("validator not found: " + title);
    return Buffer.from(v.compiledCode, "hex");
}

function cborUnwrap(buf) {
    const b0 = buf[0]; const info = b0 & 0x1f;
    let len, off;
    if (info < 24) { len = info; off = 1; }
    else if (info === 24) { len = buf[1]; off = 2; }
    else if (info === 25) { len = buf.readUInt16BE(1); off = 3; }
    else if (info === 26) { len = buf.readUInt32BE(1); off = 5; }
    else throw new Error("?");
    return buf.slice(off, off + len);
}

function loadPebble() {
    const hex = fs.readFileSync(
        path.join(traceRoot, "contracts-pebble/out/script.hex"), "utf8"
    ).trim();
    return Buffer.from(hex, "hex");
}

function unwrapToFlat(cborBuf, depth = 2) {
    let b = cborBuf;
    for (let i = 0; i < depth; i++) b = cborUnwrap(b);
    return b;
}

function decodeProgram(flatBuf) {
    return new UPLCDecoder(flatBuf).decodeProgram();
}

// ---------- term traversal ----------

function walkTerm(term, stats, depth = 0) {
    if (!term) return;
    stats.totalNodes++;
    if (depth > stats.maxDepth) stats.maxDepth = depth;
    const k = term.constructor?.name ?? "Unknown";
    stats.byKind[k] = (stats.byKind[k] ?? 0) + 1;

    if (k === "Builtin" && term.builtinTag !== undefined) {
        const tagName = String(term.builtinTag);
        stats.builtins[tagName] = (stats.builtins[tagName] ?? 0) + 1;
    }

    // UPLC term subterm fields (per @harmoniclabs/uplc):
    //   Application: func, arg
    //   Lambda:      body
    //   Force:       forced
    //   Delay:       delayedTerm
    //   Case:        constrTerm, continuations[]
    //   Constr:      terms[]
    for (const field of ["func", "arg", "body", "forced", "delayedTerm", "constrTerm"]) {
        if (term[field]) walkTerm(term[field], stats, depth + 1);
    }
    if (Array.isArray(term.continuations))
        for (const t of term.continuations) walkTerm(t, stats, depth + 1);
    if (Array.isArray(term.terms))
        for (const t of term.terms) walkTerm(t, stats, depth + 1);
}

function analyse(name, cborBuf, wrapDepth = 2) {
    const flat = unwrapToFlat(cborBuf, wrapDepth);
    const program = decodeProgram(flat);
    const stats = { totalNodes: 0, maxDepth: 0, byKind: {}, builtins: {} };
    walkTerm(program.body, stats);
    return {
        name,
        cborBytes: cborBuf.length,
        flatBytes: flat.length,
        version: program.version.toString(),
        scriptHash: Buffer.from(blake2b_224(new Uint8Array(cborBuf))).toString("hex"),
        stats,
    };
}

// ---------- run ----------

// Aiken's plutus.json compiledCode is single-CBOR-wrapped flat UPLC.
// Pebble's script.hex (after flat-to-cbor.js) is double-CBOR-wrapped.
const aiken = analyse("Aiken pharma_trace",
    loadAikenValidator("pharma_trace.pharma_trace.mint"), 1);
const pebble = analyse("Pebble PharmaTrace", loadPebble(), 2);

function row(label, a, b) {
    return `${label.padEnd(28)} | ${String(a).padStart(20)} | ${String(b).padStart(20)}`;
}

console.log("");
console.log(row("metric", "Aiken (mint endpoint)", "Pebble"));
console.log("-".repeat(76));
console.log(row("CBOR size (bytes)", aiken.cborBytes, pebble.cborBytes));
console.log(row("flat UPLC (bytes)", aiken.flatBytes, pebble.flatBytes));
console.log(row("UPLC version", aiken.version, pebble.version));
console.log(row("total UPLC term nodes", aiken.stats.totalNodes, pebble.stats.totalNodes));
console.log(row("max term depth", aiken.stats.maxDepth, pebble.stats.maxDepth));
console.log(row("script hash (blake2b-224)", aiken.scriptHash.slice(0, 16) + "…", pebble.scriptHash.slice(0, 16) + "…"));
console.log("");

// term-kind breakdown
const allKinds = new Set([...Object.keys(aiken.stats.byKind), ...Object.keys(pebble.stats.byKind)]);
console.log(row("term kind", "Aiken count", "Pebble count"));
console.log("-".repeat(76));
for (const k of [...allKinds].sort()) {
    console.log(row(k, aiken.stats.byKind[k] ?? 0, pebble.stats.byKind[k] ?? 0));
}
console.log("");

// builtin breakdown
const allBuiltins = new Set([...Object.keys(aiken.stats.builtins), ...Object.keys(pebble.stats.builtins)]);
console.log(row("builtin tag", "Aiken count", "Pebble count"));
console.log("-".repeat(76));
const sortedBuiltins = [...allBuiltins].sort((x, y) =>
    (pebble.stats.builtins[y] ?? 0) + (aiken.stats.builtins[y] ?? 0) -
    ((pebble.stats.builtins[x] ?? 0) + (aiken.stats.builtins[x] ?? 0))
);
for (const b of sortedBuiltins.slice(0, 30)) {
    const name = UPLCBuiltinTag[b] ?? `tag ${b}`;
    console.log(row(name, aiken.stats.builtins[b] ?? 0, pebble.stats.builtins[b] ?? 0));
}
console.log("");

console.log("Behavioural equivalence: see docs/differential-equivalence.md.");
