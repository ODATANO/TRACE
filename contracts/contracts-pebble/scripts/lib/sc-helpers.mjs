// Shared Plutus-V3 ScriptContext builders + UPLC evaluator + program loaders
// for the differential-equivalence harnesses (pharma_trace + cold_chain).
//
// Extracted verbatim from the original diff-equiv.mjs so both contracts test
// against identical encodings. Pure, side-effect-free except the loaders.

import * as fs from "node:fs";
import { UPLCDecoder, Application, UPLCConst } from "@harmoniclabs/uplc";
import { Machine } from "@harmoniclabs/plutus-machine";
import { DataConstr, DataI, DataB, DataList, DataMap } from "@harmoniclabs/plutus-data";

export { DataConstr, DataI, DataB, DataList, DataMap };
export { UPLCConst };

// ---------- CBOR / program loaders ----------

export function cborUnwrap(buf) {
    const i = buf[0] & 0x1f;
    let len, off;
    if (i < 24) { len = i; off = 1; }
    else if (i === 24) { len = buf[1]; off = 2; }
    else if (i === 25) { len = buf.readUInt16BE(1); off = 3; }
    else if (i === 26) { len = buf.readUInt32BE(1); off = 5; }
    else throw new Error("unsupported cbor info " + i);
    return buf.slice(off, off + len);
}

// Aiken plutus.json compiledCode is single-CBOR-wrapped flat.
export function loadAiken(plutusJsonPath, title) {
    const j = JSON.parse(fs.readFileSync(plutusJsonPath, "utf8"));
    const v = j.validators.find(x => x.title === title);
    if (!v) throw new Error("missing validator " + title);
    const flat = cborUnwrap(Buffer.from(v.compiledCode, "hex"));
    return new UPLCDecoder(flat).decodeProgram();
}

// Pebble out/script.hex is double-CBOR-wrapped hex.
export function loadPebbleHex(hexPath) {
    const cbor = Buffer.from(fs.readFileSync(hexPath, "utf8").trim(), "hex");
    const flat = cborUnwrap(cborUnwrap(cbor));
    return new UPLCDecoder(flat).decodeProgram();
}

// Pebble out/out.flat is the raw flat program (no CBOR wrapping).
export function loadPebbleFlat(flatPath) {
    return new UPLCDecoder(fs.readFileSync(flatPath)).decodeProgram();
}

// ---------- PlutusV3 building blocks ----------

export function txOutRef(txId, idx) {
    return new DataConstr(0n, [new DataB(txId), new DataI(BigInt(idx))]);
}
export function pubkeyAddress(vkh) {
    return new DataConstr(0n, [
        new DataConstr(0n, [new DataB(vkh)]),     // Credential::PubKeyCredential
        new DataConstr(1n, [])                     // no staking
    ]);
}
export function scriptAddress(scriptHash) {
    return new DataConstr(0n, [
        new DataConstr(1n, [new DataB(scriptHash)]),
        new DataConstr(1n, [])
    ]);
}
// Value = Map PolicyId (Map AssetName Int)
export function value(adaLovelace, assets = []) {
    const policyEntries = new Map();
    if (adaLovelace !== null) {
        policyEntries.set("", [[Buffer.alloc(0), BigInt(adaLovelace)]]);
    }
    for (const [policy, name, qty] of assets) {
        const key = policy.toString("hex");
        if (!policyEntries.has(key)) policyEntries.set(key, []);
        policyEntries.get(key).push([name, BigInt(qty)]);
    }
    const pairs = [];
    for (const [policyKey, entries] of policyEntries.entries()) {
        const policyBytes = policyKey === "" ? Buffer.alloc(0) : Buffer.from(policyKey, "hex");
        const inner = new DataMap(entries.map(([n, q]) => ({ fst: new DataB(n), snd: new DataI(q) })));
        pairs.push({ fst: new DataB(policyBytes), snd: inner });
    }
    return new DataMap(pairs);
}
export function txOut(addr, val, datum, refScript = new DataConstr(1n, [])) {
    return new DataConstr(0n, [addr, val, datum, refScript]);
}
export function noDatum() { return new DataConstr(0n, []); }
export function inlineDatum(d) { return new DataConstr(2n, [d]); }
export function txIn(ref, output) { return new DataConstr(0n, [ref, output]); }
export function emptyMap() { return new DataMap([]); }
export function emptyList() { return new DataList([]); }
export function noneOpt() { return new DataConstr(1n, []); }
export function someOpt(d) { return new DataConstr(0n, [d]); }
export function interval() {
    return new DataConstr(0n, [
        new DataConstr(0n, [new DataConstr(0n, []), new DataConstr(1n, [])]),
        new DataConstr(0n, [new DataConstr(2n, []), new DataConstr(1n, [])])
    ]);
}

export function txInfo({
    inputs = [], refInputs = [], outputs = [], fee = 0,
    mint = null, signatories = [], redeemers = null, txData = null
}) {
    const mintVal = mint ?? value(null, []);
    return new DataConstr(0n, [
        new DataList(inputs),                                        // 0  inputs
        new DataList(refInputs),                                     // 1  reference inputs
        new DataList(outputs),                                       // 2  outputs
        new DataI(BigInt(fee)),                                       // 3  fee
        mintVal,                                                     // 4  mint
        emptyList(),                                                 // 5  txCerts
        emptyMap(),                                                  // 6  withdrawals
        interval(),                                                  // 7  validity range
        new DataList(signatories.map(b => new DataB(b))),            // 8  signatories
        redeemers ?? emptyMap(),                                     // 9  redeemers
        txData ?? emptyMap(),                                        // 10 datums
        new DataConstr(0n, [new DataB(Buffer.alloc(32, 0xee))]),     // 11 txId
        emptyMap(),                                                  // 12 votes
        emptyList(),                                                 // 13 proposals
        noneOpt(),                                                   // 14 currentTreasury
        noneOpt(),                                                   // 15 treasuryDonation
    ]);
}

export function mintingCtx(redeemer, txInfoData, currencySymbol) {
    return new DataConstr(0n, [
        txInfoData,
        redeemer,
        new DataConstr(0n, [new DataB(currencySymbol)])              // ScriptInfo::Minting
    ]);
}
export function spendingCtx(redeemer, datum, txInfoData, ownRef) {
    const datumOpt = datum ? someOpt(datum) : noneOpt();
    return new DataConstr(0n, [
        txInfoData,
        redeemer,
        new DataConstr(1n, [ownRef, datumOpt])                       // ScriptInfo::Spending
    ]);
}

// ---------- evaluator ----------

// paramConsts is an array of pre-built UPLCConst values — lets callers choose the
// param ENCODING per backend (e.g. native bytestring for Pebble scalar params vs
// Data for Aiken). Build them with UPLCConst.data(...) / UPLCConst.byteString(...).
export function evalScript(program, paramConsts, ctxData) {
    let term = program.body;
    for (const c of paramConsts) term = new Application(term, c);
    term = new Application(term, UPLCConst.data(ctxData));
    try {
        const r = Machine.evalSimple(term);
        if (r?.constructor?.name === "CEKConst") return "ACCEPT";
        const detail = r?.msg ?? r?.message ?? r?.cause?.message ?? r?.kind;
        return "REJECT" + (detail ? ":" + String(detail).slice(0, 80) : "");
    } catch (e) {
        return "ERR:" + (e.message?.slice(0, 80));
    }
}

function shortResult(r) { return r.startsWith("ACCEPT") ? "ACCEPT" : "REJECT"; }

// ---------- suite runner ----------

// Returns { test, run }. `test(name, expected, mkAikenCtx, mkPebbleCtx, pebbleExpected?)`
// where pebbleExpected records a deliberate, documented divergence (defaults to
// `expected`). `run(...)` evaluates all tests, prints a table, returns mismatches.
export function createSuite(title) {
    const TESTS = [];
    function test(name, expected, mkAikenCtx, mkPebbleCtx, pebbleExpected) {
        TESTS.push({ name, expected, pebbleExpected: pebbleExpected ?? expected, mkAikenCtx, mkPebbleCtx });
    }
    function run({ aikenProgram, pebbleProgram, aikenParams, pebbleParams }) {
        let ok = 0, mismatch = 0;
        const mismatches = [];
        console.log("\n" + title);
        console.log("Test                                                   | Aiken    | Pebble   | Expected | Match");
        console.log("-".repeat(105));
        for (const t of TESTS) {
            const aShort = shortResult(evalScript(aikenProgram, aikenParams, t.mkAikenCtx()));
            const pShort = shortResult(evalScript(pebbleProgram, pebbleParams, t.mkPebbleCtx()));
            const divergent = t.expected !== t.pebbleExpected;
            const match = aShort === t.expected && pShort === t.pebbleExpected;
            if (match) ok++; else { mismatch++; mismatches.push({ t, aShort, pShort }); }
            const stat = match ? (divergent ? "OK (known div.)" : "OK") : "MISMATCH";
            console.log(`${t.name.padEnd(54)} | ${aShort.padEnd(8)} | ${pShort.padEnd(8)} | ${t.expected.padEnd(8)} | ${stat}`);
        }
        if (mismatches.length > 0) {
            console.log("\nMismatch detail:");
            for (const m of mismatches) console.log(`  ${m.t.name}\n    Aiken:  ${m.aShort}\n    Pebble: ${m.pShort}`);
        }
        console.log(`\n${ok}/${TESTS.length} passed, ${mismatch} mismatches`);
        return mismatch;
    }
    return { test, run };
}
