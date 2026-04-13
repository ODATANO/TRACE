// Differential equivalence test: evaluate Aiken and Pebble compiled
// validators against identical Plutus V3 ScriptContexts and compare
// accept/reject outcomes.
//
// This is *not* a proof of equivalence (that would require exhaustive
// or symbolic testing) — it's a sanity check that both validators agree
// on a curated set of representative scenarios per endpoint.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { UPLCDecoder, Application, UPLCConst } from "@harmoniclabs/uplc";
import { Machine } from "@harmoniclabs/plutus-machine";
import { DataConstr, DataI, DataB, DataList, DataMap } from "@harmoniclabs/plutus-data";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const traceRoot = path.resolve(__dirname, "../..");

// ---------- script loaders ----------

function cborUnwrap(buf) {
    const i = buf[0] & 0x1f;
    let len, off;
    if (i < 24) { len = i; off = 1; }
    else if (i === 24) { len = buf[1]; off = 2; }
    else if (i === 25) { len = buf.readUInt16BE(1); off = 3; }
    else if (i === 26) { len = buf.readUInt32BE(1); off = 5; }
    else throw new Error("unsupported cbor info " + i);
    return buf.slice(off, off + len);
}

function loadAiken(title) {
    const j = JSON.parse(fs.readFileSync(path.join(traceRoot, "contracts/plutus.json"), "utf8"));
    const v = j.validators.find(x => x.title === title);
    if (!v) throw new Error("missing validator " + title);
    const cbor = Buffer.from(v.compiledCode, "hex");
    const flat = cborUnwrap(cbor); // single-wrapped
    return new UPLCDecoder(flat).decodeProgram();
}

function loadPebble() {
    const hex = fs.readFileSync(path.join(traceRoot, "contracts-pebble/out/script.hex"), "utf8").trim();
    const cbor = Buffer.from(hex, "hex");
    const flat = cborUnwrap(cborUnwrap(cbor)); // double-wrapped
    return new UPLCDecoder(flat).decodeProgram();
}

// Aiken builds three validator entries (mint, spend, else) — same UPLC, three names.
// Pebble has one entry. Use the .mint Aiken view as canonical.
const aikenProgram = loadAiken("pharma_trace.pharma_trace.mint");
const pebbleProgram = loadPebble();

// ---------- common test fixtures ----------

const MFR_VKH       = Buffer.alloc(28, 0x11);
const HOLDER_B_VKH  = Buffer.alloc(28, 0x22);
const SEED_TX_HASH  = Buffer.alloc(32, 0x44);
const SEED_OUT_IDX  = 0;
// Policy ID is derived from the applied script. For these tests the script
// hash will not be the actual policy because we craft synthetic contexts —
// but the validator only compares it against the value flowing through
// `context.policy` / output addresses, so we pick a stable placeholder and
// use it consistently throughout each test.
const POLICY        = Buffer.alloc(28, 0x33);
const COUNTER_TX    = Buffer.alloc(32, 0x66);
const BATCH_TX      = Buffer.alloc(32, 0x55);
const COUNTER_NAME  = Buffer.alloc(0); // empty asset name

// PlutusV3 building blocks
function txOutRef(txId, idx) {
    // Aiken's OutputReference and Pebble's TxOutRef both declare the transaction
    // id as bare bytes (ByteArray / Hash32), not wrapped in a TxId Constr.
    return new DataConstr(0n, [
        new DataB(txId),
        new DataI(BigInt(idx))
    ]);
}
function pubkeyAddress(vkh) {
    return new DataConstr(0n, [
        new DataConstr(0n, [new DataB(vkh)]),     // Credential::PubKeyCredential
        new DataConstr(1n, [])                     // no staking
    ]);
}
function scriptAddress(scriptHash) {
    return new DataConstr(0n, [
        new DataConstr(1n, [new DataB(scriptHash)]),
        new DataConstr(1n, [])
    ]);
}
// Value = Map PolicyId (Map AssetName Int)
function value(adaLovelace, assets = []) {
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
function txOut(addr, val, datum, refScript = new DataConstr(1n, [])) {
    // V3 TxOut = Constr 0 [Address, Value, Datum, Maybe ScriptHash]
    return new DataConstr(0n, [addr, val, datum, refScript]);
}
function noDatum() { return new DataConstr(0n, []); }
function inlineDatum(d) { return new DataConstr(2n, [d]); }
function txIn(ref, output) {
    // TxInInfo = Constr 0 [TxOutRef, TxOut]
    return new DataConstr(0n, [ref, output]);
}
function emptyMap() { return new DataMap([]); }
function emptyList() { return new DataList([]); }
function noneOpt() { return new DataConstr(1n, []); }
function someOpt(d) { return new DataConstr(0n, [d]); }
function interval() {
    // (-inf, +inf)
    return new DataConstr(0n, [
        new DataConstr(0n, [new DataConstr(0n, []), new DataConstr(1n, [])]),
        new DataConstr(0n, [new DataConstr(2n, []), new DataConstr(1n, [])])
    ]);
}

function txInfo({
    inputs = [], refInputs = [], outputs = [], fee = 0,
    mint = null, signatories = [], redeemers = null, txData = null
}) {
    const mintVal = mint ?? value(null, []);
    return new DataConstr(0n, [
        new DataList(inputs),                                        // 0  inputs
        new DataList(refInputs),                                     // 1  reference inputs
        new DataList(outputs),                                       // 2  outputs
        new DataI(BigInt(fee)),                                       // 3  fee (lovelace)
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

function mintingCtx(redeemer, txInfoData, currencySymbol = POLICY) {
    return new DataConstr(0n, [
        txInfoData,                                                  // tx_info
        redeemer,                                                    // redeemer
        new DataConstr(0n, [new DataB(currencySymbol)])              // ScriptInfo::Minting
    ]);
}
function spendingCtx(redeemer, datum, txInfoData, ownRef) {
    // ScriptInfo::Spending = Constr 1 [TxOutRef, Maybe Datum]
    const datumOpt = datum ? someOpt(datum) : noneOpt();
    return new DataConstr(0n, [
        txInfoData,
        redeemer,
        new DataConstr(1n, [ownRef, datumOpt])
    ]);
}

// ---------- evaluator ----------

function evalScript(program, paramData, ctxData) {
    let term = program.body;
    for (const p of paramData) term = new Application(term, UPLCConst.data(p));
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

// Aiken and Pebble both expect the same two params (manufacturer, seed) before ctx.
const PARAMS = [
    new DataB(MFR_VKH),
    txOutRef(SEED_TX_HASH, SEED_OUT_IDX),
];

// Redeemer mappers: Aiken and Pebble enumerate mint endpoints in different orders.
//   Aiken:  MintAction = InitCounter(0) | MintBatch{i}(1) | Burn(2)
//   Pebble: mintBatch(0), initCounter(1), burn(2)
// Spend endpoints happen to match: Transfer(0), Deliver(1), IncrementCounter(2).
const aikenInitCounter = new DataConstr(0n, []);
const pebbleInitCounter = new DataConstr(1n, []);
const aikenBurn = new DataConstr(2n, []);
const pebbleBurn = new DataConstr(2n, []);
const aikenMintBatch = (i) => new DataConstr(1n, [new DataI(BigInt(i))]);
const pebbleMintBatch = (i) => new DataConstr(0n, [new DataI(BigInt(i))]);

const transfer = (i, o) => new DataConstr(0n, [new DataI(BigInt(i)), new DataI(BigInt(o))]);
const deliver = new DataConstr(1n, []);
const incrementCounter = (i) => new DataConstr(2n, [new DataI(BigInt(i))]);

// ---------- test helpers ----------

const TESTS = [];
function test(name, expected, mkAikenCtx, mkPebbleCtx) {
    TESTS.push({ name, expected, mkAikenCtx, mkPebbleCtx });
}

// Wallet UTxO (pure ADA at manufacturer's pubkey address)
function walletInput(ref) {
    return txIn(ref,
        txOut(pubkeyAddress(MFR_VKH), value(5_000_000), noDatum())
    );
}
// Counter UTxO
function counterInput(ref, n) {
    const datum = inlineDatum(new DataConstr(1n, [new DataI(BigInt(n))]));
    return txIn(ref,
        txOut(scriptAddress(POLICY), value(2_000_000, [[POLICY, COUNTER_NAME, 1]]), datum)
    );
}
// Counter output
function counterOutput(n) {
    const datum = inlineDatum(new DataConstr(1n, [new DataI(BigInt(n))]));
    return txOut(scriptAddress(POLICY), value(2_000_000, [[POLICY, COUNTER_NAME, 1]]), datum);
}
// Batch output
function batchOutput(name) {
    const datum = inlineDatum(new DataConstr(0n, [
        new DataB(MFR_VKH),
        new DataB(MFR_VKH),
        new DataB(name),
        new DataI(0n),
    ]));
    return txOut(scriptAddress(POLICY), value(2_000_000, [[POLICY, name, 1]]), datum);
}
// Batch input (for transfer/deliver tests)
function batchInput(ref, holder, step, name) {
    const datum = inlineDatum(new DataConstr(0n, [
        new DataB(MFR_VKH),
        new DataB(holder),
        new DataB(name),
        new DataI(BigInt(step)),
    ]));
    return txIn(ref,
        txOut(scriptAddress(POLICY), value(2_000_000, [[POLICY, name, 1]]), datum)
    );
}
function transferOutput(nextHolder, step, name) {
    const datum = inlineDatum(new DataConstr(0n, [
        new DataB(MFR_VKH),
        new DataB(nextHolder),
        new DataB(name),
        new DataI(BigInt(step)),
    ]));
    return txOut(scriptAddress(POLICY), value(2_000_000, [[POLICY, name, 1]]), datum);
}

// ---------- test cases ----------

// MINT :: burn — accept (negative qty)
test("burn accepts negative qty", "ACCEPT",
    () => mintingCtx(aikenBurn, txInfo({
        mint: value(null, [[POLICY, Buffer.from([1]), -1]])
    })),
    () => mintingCtx(pebbleBurn, txInfo({
        mint: value(null, [[POLICY, Buffer.from([1]), -1]])
    }))
);
// MINT :: burn — reject (positive qty)
test("burn rejects positive qty", "REJECT",
    () => mintingCtx(aikenBurn, txInfo({
        mint: value(null, [[POLICY, Buffer.from([1]), 1]])
    })),
    () => mintingCtx(pebbleBurn, txInfo({
        mint: value(null, [[POLICY, Buffer.from([1]), 1]])
    }))
);

// MINT :: initCounter — accept
test("initCounter accepts valid seed-spend + counter mint", "ACCEPT",
    () => mintingCtx(aikenInitCounter, txInfo({
        inputs: [walletInput(txOutRef(SEED_TX_HASH, SEED_OUT_IDX))],
        outputs: [counterOutput(0)],
        mint: value(null, [[POLICY, COUNTER_NAME, 1]]),
        signatories: [MFR_VKH]
    })),
    () => mintingCtx(pebbleInitCounter, txInfo({
        inputs: [walletInput(txOutRef(SEED_TX_HASH, SEED_OUT_IDX))],
        outputs: [counterOutput(0)],
        mint: value(null, [[POLICY, COUNTER_NAME, 1]]),
        signatories: [MFR_VKH]
    }))
);

// MINT :: initCounter — reject (no seed consumed)
test("initCounter rejects without seed", "REJECT",
    () => {
        const otherTx = Buffer.alloc(32, 0xaa);
        return mintingCtx(aikenInitCounter, txInfo({
            inputs: [walletInput(txOutRef(otherTx, 0))],
            outputs: [counterOutput(0)],
            mint: value(null, [[POLICY, COUNTER_NAME, 1]]),
        }));
    },
    () => {
        const otherTx = Buffer.alloc(32, 0xaa);
        return mintingCtx(pebbleInitCounter, txInfo({
            inputs: [walletInput(txOutRef(otherTx, 0))],
            outputs: [counterOutput(0)],
            mint: value(null, [[POLICY, COUNTER_NAME, 1]]),
        }));
    }
);

// MINT :: mintBatch — accept (counter at idx 0)
test("mintBatch accepts when counter is at given index", "ACCEPT",
    () => mintingCtx(aikenMintBatch(0), txInfo({
        inputs: [counterInput(txOutRef(COUNTER_TX, 0), 0)],
    })),
    () => mintingCtx(pebbleMintBatch(0), txInfo({
        inputs: [counterInput(txOutRef(COUNTER_TX, 0), 0)],
    }))
);

// MINT :: mintBatch — reject (input is wallet not script)
test("mintBatch rejects when input at idx is wallet", "REJECT",
    () => mintingCtx(aikenMintBatch(0), txInfo({
        inputs: [walletInput(txOutRef(COUNTER_TX, 0))],
    })),
    () => mintingCtx(pebbleMintBatch(0), txInfo({
        inputs: [walletInput(txOutRef(COUNTER_TX, 0))],
    }))
);

// SPEND :: deliver — accept
test("deliver accepts with current_holder signature", "ACCEPT",
    () => {
        const ref = txOutRef(BATCH_TX, 0);
        const datum = new DataConstr(0n, [
            new DataB(MFR_VKH), new DataB(MFR_VKH),
            new DataB(Buffer.from([1])), new DataI(3n),
        ]);
        return spendingCtx(deliver, datum, txInfo({
            inputs: [batchInput(ref, MFR_VKH, 3, Buffer.from([1]))],
            signatories: [MFR_VKH],
        }), ref);
    },
    () => {
        const ref = txOutRef(BATCH_TX, 0);
        const datum = new DataConstr(0n, [
            new DataB(MFR_VKH), new DataB(MFR_VKH),
            new DataB(Buffer.from([1])), new DataI(3n),
        ]);
        return spendingCtx(deliver, datum, txInfo({
            inputs: [batchInput(ref, MFR_VKH, 3, Buffer.from([1]))],
            signatories: [MFR_VKH],
        }), ref);
    }
);

// SPEND :: deliver — reject (no signature)
test("deliver rejects without holder signature", "REJECT",
    () => {
        const ref = txOutRef(BATCH_TX, 0);
        const datum = new DataConstr(0n, [
            new DataB(MFR_VKH), new DataB(MFR_VKH),
            new DataB(Buffer.from([1])), new DataI(3n),
        ]);
        return spendingCtx(deliver, datum, txInfo({
            inputs: [batchInput(ref, MFR_VKH, 3, Buffer.from([1]))],
            signatories: [],
        }), ref);
    },
    () => {
        const ref = txOutRef(BATCH_TX, 0);
        const datum = new DataConstr(0n, [
            new DataB(MFR_VKH), new DataB(MFR_VKH),
            new DataB(Buffer.from([1])), new DataI(3n),
        ]);
        return spendingCtx(deliver, datum, txInfo({
            inputs: [batchInput(ref, MFR_VKH, 3, Buffer.from([1]))],
            signatories: [],
        }), ref);
    }
);

// SPEND :: transfer — accept
test("transfer accepts valid step+1 continuing output", "ACCEPT",
    () => {
        const ref = txOutRef(BATCH_TX, 0);
        const name = Buffer.from([1]);
        const datum = new DataConstr(0n, [
            new DataB(MFR_VKH), new DataB(MFR_VKH),
            new DataB(name), new DataI(0n),
        ]);
        return spendingCtx(transfer(0, 0), datum, txInfo({
            inputs: [batchInput(ref, MFR_VKH, 0, name)],
            outputs: [transferOutput(HOLDER_B_VKH, 1, name)],
            signatories: [MFR_VKH],
        }), ref);
    },
    () => {
        const ref = txOutRef(BATCH_TX, 0);
        const name = Buffer.from([1]);
        const datum = new DataConstr(0n, [
            new DataB(MFR_VKH), new DataB(MFR_VKH),
            new DataB(name), new DataI(0n),
        ]);
        return spendingCtx(transfer(0, 0), datum, txInfo({
            inputs: [batchInput(ref, MFR_VKH, 0, name)],
            outputs: [transferOutput(HOLDER_B_VKH, 1, name)],
            signatories: [MFR_VKH],
        }), ref);
    }
);

// SPEND :: transfer — reject (step not incremented)
test("transfer rejects when step not incremented", "REJECT",
    () => {
        const ref = txOutRef(BATCH_TX, 0);
        const name = Buffer.from([1]);
        const datum = new DataConstr(0n, [
            new DataB(MFR_VKH), new DataB(MFR_VKH),
            new DataB(name), new DataI(0n),
        ]);
        return spendingCtx(transfer(0, 0), datum, txInfo({
            inputs: [batchInput(ref, MFR_VKH, 0, name)],
            outputs: [transferOutput(HOLDER_B_VKH, 0, name)],  // step=0, not 1
            signatories: [MFR_VKH],
        }), ref);
    },
    () => {
        const ref = txOutRef(BATCH_TX, 0);
        const name = Buffer.from([1]);
        const datum = new DataConstr(0n, [
            new DataB(MFR_VKH), new DataB(MFR_VKH),
            new DataB(name), new DataI(0n),
        ]);
        return spendingCtx(transfer(0, 0), datum, txInfo({
            inputs: [batchInput(ref, MFR_VKH, 0, name)],
            outputs: [transferOutput(HOLDER_B_VKH, 0, name)],
            signatories: [MFR_VKH],
        }), ref);
    }
);

// SPEND :: incrementCounter — accept (single batch)
test("incrementCounter accepts single new batch", "ACCEPT",
    () => {
        const ref = txOutRef(COUNTER_TX, 0);
        const datum = new DataConstr(1n, [new DataI(0n)]); // MintCounter{0}
        const name = Buffer.from([1]);  // 1 as bytes (minimal BE)
        return spendingCtx(incrementCounter(0), datum, txInfo({
            inputs: [counterInput(ref, 0)],
            outputs: [counterOutput(1), batchOutput(name)],
            mint: value(null, [[POLICY, name, 1]]),
            signatories: [MFR_VKH],
        }), ref);
    },
    () => {
        const ref = txOutRef(COUNTER_TX, 0);
        const datum = new DataConstr(1n, [new DataI(0n)]);
        const name = Buffer.from([1]);
        return spendingCtx(incrementCounter(0), datum, txInfo({
            inputs: [counterInput(ref, 0)],
            outputs: [counterOutput(1), batchOutput(name)],
            mint: value(null, [[POLICY, name, 1]]),
            signatories: [MFR_VKH],
        }), ref);
    }
);


// SPEND :: incrementCounter — reject (no manufacturer signature)
test("incrementCounter rejects without manufacturer signature", "REJECT",
    () => {
        const ref = txOutRef(COUNTER_TX, 0);
        const datum = new DataConstr(1n, [new DataI(0n)]);
        const name = Buffer.from([1]);
        return spendingCtx(incrementCounter(0), datum, txInfo({
            inputs: [counterInput(ref, 0)],
            outputs: [counterOutput(1), batchOutput(name)],
            mint: value(null, [[POLICY, name, 1]]),
            signatories: [],
        }), ref);
    },
    () => {
        const ref = txOutRef(COUNTER_TX, 0);
        const datum = new DataConstr(1n, [new DataI(0n)]);
        const name = Buffer.from([1]);
        return spendingCtx(incrementCounter(0), datum, txInfo({
            inputs: [counterInput(ref, 0)],
            outputs: [counterOutput(1), batchOutput(name)],
            mint: value(null, [[POLICY, name, 1]]),
            signatories: [],
        }), ref);
    }
);

// ---------- run + report ----------

function shortResult(r) {
    if (r === "ACCEPT") return "ACCEPT";
    if (r.startsWith("REJECT")) return "REJECT";
    return r;
}

let ok = 0, mismatch = 0;
const mismatches = [];
console.log("");
console.log("Test                                                   | Aiken    | Pebble   | Expected | Match");
console.log("-".repeat(105));
for (const t of TESTS) {
    const aR = evalScript(aikenProgram, PARAMS, t.mkAikenCtx());
    const pR = evalScript(pebbleProgram, PARAMS, t.mkPebbleCtx());
    const aShort = shortResult(aR);
    const pShort = shortResult(pR);
    const match = aShort === pShort && aShort === t.expected;
    if (match) ok++; else { mismatch++; mismatches.push({ t, aR, pR }); }
    console.log(`${t.name.padEnd(54)} | ${aShort.padEnd(8)} | ${pShort.padEnd(8)} | ${t.expected.padEnd(8)} | ${match ? "OK" : "MISMATCH"}`);
}
if (mismatches.length > 0) {
    console.log("\nMismatch detail:");
    for (const m of mismatches) {
        console.log(`  ${m.t.name}`);
        console.log(`    Aiken:  ${m.aR}`);
        console.log(`    Pebble: ${m.pR}`);
    }
}
console.log("");
console.log(`${ok}/${TESTS.length} passed, ${mismatch} mismatches`);
process.exit(mismatch === 0 ? 0 : 1);
