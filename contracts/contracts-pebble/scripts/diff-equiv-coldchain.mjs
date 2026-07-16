// Differential equivalence for the cold_chain validator: evaluate the Aiken and
// Pebble compiled programs against identical Plutus V3 ScriptContexts and
// confirm matching accept/reject outcomes. Mirrors diff-equiv.mjs (pharma) but
// for the condition-monitoring ABI.
//
// Prereqs: `aiken build` (contracts-aiken/plutus.json) and `npm run compile:coldchain`
// (contracts-pebble/out-coldchain/out.flat).
//
// ABI:
//   Datum  MonitorState=0 { oracle, batch_id, min, max, rc, bc, root, breached }
//   Mint   InitMonitor=0  | BurnMonitor=1
//   Spend  RecordReadings(i,o)=0 | Close=1

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    loadAiken, loadPebbleFlat,
    txOutRef, pubkeyAddress, scriptAddress, value, txOut, noDatum, inlineDatum,
    txIn, txInfo, mintingCtx, spendingCtx, createSuite,
    DataConstr, DataI, DataB, UPLCConst,
} from "./lib/sc-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const traceRoot = path.resolve(__dirname, "../..");

const aikenProgram = loadAiken(path.join(traceRoot, "contracts-aiken/plutus.json"), "cold_chain.cold_chain.mint");
const pebbleProgram = loadPebbleFlat(path.join(traceRoot, "contracts-pebble/out-coldchain/out.flat"));

// ---------- fixtures ----------

const ORACLE     = Buffer.alloc(28, 0xaa);
const OTHER      = Buffer.alloc(28, 0xbb);
const SEED_TX    = Buffer.alloc(32, 0x44);
const SEED_IDX   = 0;
const POLICY     = Buffer.alloc(28, 0x33);
const MON_TX     = Buffer.alloc(32, 0x55);
const MON_NAME   = Buffer.alloc(0);                 // empty thread-token name
const ROOT_A     = Buffer.alloc(32, 0x00);          // 32-byte commit roots
const ROOT_B     = Buffer.alloc(32, 0x11);
const SHORT_ROOT = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
const BATCH_ID   = Buffer.from([0x01]);

// cold_chain is parameterised by (oracle: VKH, seed: OutputReference).
// Param ENCODING differs by compiler: Aiken applies every param as Data;
// Pebble types scalars natively, so `oracle: PubKeyHash` is a native bytestring
// while `seed: TxOutRef` (a struct) is Data. Mirrors @odatano/core's typed
// applyScriptParameters.
const AIKEN_PARAMS = [
    UPLCConst.data(new DataB(ORACLE)),
    UPLCConst.data(txOutRef(SEED_TX, SEED_IDX)),
];
const PEBBLE_PARAMS = [
    UPLCConst.byteString(ORACLE),                    // native PubKeyHash
    UPLCConst.data(txOutRef(SEED_TX, SEED_IDX)),     // struct -> Data
];

// MonitorState datum (Constr 0) — oracle is the script param, not a datum field.
function monitorDatum(rc, bc, root, breached, opts = {}) {
    const { batchId = BATCH_ID, min = 2000, max = 8000 } = opts;
    return new DataConstr(0n, [
        new DataB(batchId),
        new DataI(BigInt(min)), new DataI(BigInt(max)),
        new DataI(BigInt(rc)), new DataI(BigInt(bc)),
        new DataB(root), new DataI(BigInt(breached)),
    ]);
}
function stateOutput(datum) {
    return txOut(scriptAddress(POLICY), value(2_000_000, [[POLICY, MON_NAME, 1]]), inlineDatum(datum));
}
function monitorInput(ref, datum) {
    return txIn(ref, stateOutput(datum));
}
function walletInput(ref) {
    return txIn(ref, txOut(pubkeyAddress(ORACLE), value(5_000_000), noDatum()));
}

// Redeemers (both backends aligned).
const initMonitor = new DataConstr(0n, []);
const burnMonitor = new DataConstr(1n, []);
const recordReadings = (i, o) => new DataConstr(0n, [new DataI(BigInt(i)), new DataI(BigInt(o))]);
const close = new DataConstr(1n, []);

const MON_REF = txOutRef(MON_TX, 0);

const { test, run } = createSuite("=== cold_chain (Aiken vs Pebble) ===");

// ---------- mint :: initMonitor ----------

const initCtx = (mkOutputs, mkInputs, mint = value(null, [[POLICY, MON_NAME, 1]]), sigs = [ORACLE]) =>
    mintingCtx(initMonitor, txInfo({ inputs: mkInputs, outputs: mkOutputs, mint, signatories: sigs }), POLICY);

test("initMonitor accepts valid", "ACCEPT",
    () => initCtx([stateOutput(monitorDatum(0, 0, ROOT_A, 0))], [walletInput(txOutRef(SEED_TX, 0))]),
    () => initCtx([stateOutput(monitorDatum(0, 0, ROOT_A, 0))], [walletInput(txOutRef(SEED_TX, 0))]),
);

test("initMonitor rejects without seed", "REJECT",
    () => initCtx([stateOutput(monitorDatum(0, 0, ROOT_A, 0))], [walletInput(txOutRef(Buffer.alloc(32, 0x99), 0))]),
    () => initCtx([stateOutput(monitorDatum(0, 0, ROOT_A, 0))], [walletInput(txOutRef(Buffer.alloc(32, 0x99), 0))]),
);

test("initMonitor rejects nonzero reading_count", "REJECT",
    () => initCtx([stateOutput(monitorDatum(5, 0, ROOT_A, 0))], [walletInput(txOutRef(SEED_TX, 0))]),
    () => initCtx([stateOutput(monitorDatum(5, 0, ROOT_A, 0))], [walletInput(txOutRef(SEED_TX, 0))]),
);

test("initMonitor rejects bad root length", "REJECT",
    () => initCtx([stateOutput(monitorDatum(0, 0, SHORT_ROOT, 0))], [walletInput(txOutRef(SEED_TX, 0))]),
    () => initCtx([stateOutput(monitorDatum(0, 0, SHORT_ROOT, 0))], [walletInput(txOutRef(SEED_TX, 0))]),
);

test("initMonitor rejects inverted spec (min > max)", "REJECT",
    () => initCtx([stateOutput(monitorDatum(0, 0, ROOT_A, 0, { min: 8000, max: 2000 }))], [walletInput(txOutRef(SEED_TX, 0))]),
    () => initCtx([stateOutput(monitorDatum(0, 0, ROOT_A, 0, { min: 8000, max: 2000 }))], [walletInput(txOutRef(SEED_TX, 0))]),
);

// ---------- mint :: burnMonitor ----------

test("burnMonitor accepts negative qty", "ACCEPT",
    () => mintingCtx(burnMonitor, txInfo({ mint: value(null, [[POLICY, MON_NAME, -1]]) }), POLICY),
    () => mintingCtx(burnMonitor, txInfo({ mint: value(null, [[POLICY, MON_NAME, -1]]) }), POLICY),
);

test("burnMonitor rejects positive qty", "REJECT",
    () => mintingCtx(burnMonitor, txInfo({ mint: value(null, [[POLICY, MON_NAME, 1]]) }), POLICY),
    () => mintingCtx(burnMonitor, txInfo({ mint: value(null, [[POLICY, MON_NAME, 1]]) }), POLICY),
);

// ---------- spend :: recordReadings ----------

const recCtx = (inDatum, outDatum, sigs = [ORACLE]) =>
    spendingCtx(
        recordReadings(0, 0),
        inDatum,
        txInfo({ inputs: [monitorInput(MON_REF, inDatum)], outputs: [stateOutput(outDatum)], signatories: sigs }),
        MON_REF,
    );

test("recordReadings accepts clean batch", "ACCEPT",
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(20, 0, ROOT_B, 0)),
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(20, 0, ROOT_B, 0)),
);

test("recordReadings accepts breach (latches)", "ACCEPT",
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(20, 3, ROOT_B, 1)),
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(20, 3, ROOT_B, 1)),
);

test("recordReadings rejects without oracle sig", "REJECT",
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(20, 0, ROOT_B, 0), [OTHER]),
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(20, 0, ROOT_B, 0), [OTHER]),
);

test("recordReadings rejects count not increased", "REJECT",
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(10, 0, ROOT_B, 0)),
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(10, 0, ROOT_B, 0)),
);

test("recordReadings rejects unlatching breach", "REJECT",
    () => recCtx(monitorDatum(20, 3, ROOT_A, 1), monitorDatum(30, 3, ROOT_B, 0)),
    () => recCtx(monitorDatum(20, 3, ROOT_A, 1), monitorDatum(30, 3, ROOT_B, 0)),
);

test("recordReadings rejects breach flag not set", "REJECT",
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(20, 2, ROOT_B, 0)),
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(20, 2, ROOT_B, 0)),
);

test("recordReadings rejects batch_id changed", "REJECT",
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(20, 0, ROOT_B, 0, { batchId: Buffer.from([0x02]) })),
    () => recCtx(monitorDatum(10, 0, ROOT_A, 0), monitorDatum(20, 0, ROOT_B, 0, { batchId: Buffer.from([0x02]) })),
);

// ---------- spend :: close ----------

const closeCtx = (sigs) =>
    spendingCtx(close, monitorDatum(30, 1, ROOT_B, 1),
        txInfo({ inputs: [monitorInput(MON_REF, monitorDatum(30, 1, ROOT_B, 1))], signatories: sigs }), MON_REF);

test("close accepts with oracle sig", "ACCEPT",
    () => closeCtx([ORACLE]),
    () => closeCtx([ORACLE]),
);

test("close rejects without oracle sig", "REJECT",
    () => closeCtx([OTHER]),
    () => closeCtx([OTHER]),
);

process.exit(run({ aikenProgram, pebbleProgram, aikenParams: AIKEN_PARAMS, pebbleParams: PEBBLE_PARAMS }));
