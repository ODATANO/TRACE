// End-to-end cold-chain driver against a LIVE TraceService (preview testnet).
//
// Drives: ensure participant + counter + minted batch → InitColdChainMonitor →
// RecordSensorReadings (clean) → RecordSensorReadings (breach) → VerifyBatch
// (expect breached) → CloseColdChainMonitor. Each on-chain step is built by the
// service, signed locally (scripts/testnet/signer.mjs), submitted, then polled
// to confirmation via CheckPendingTransactions.
//
// Prereqs & env: see scripts/testnet/README.md. This script is UNTESTED on a
// live backend (no funded wallet available at authoring time) — treat the first
// run as a validation of the on-chain path, not a guarantee.
//
// Usage:
//   node scripts/testnet/coldchain-e2e.mjs            # full submit flow
//   node scripts/testnet/coldchain-e2e.mjs --dry-run  # build only; print + stop
//
// Required env: WALLET_ADDRESS, WALLET_VKH, (WALLET_SKEY_HEX unless --dry-run).
// Optional env: TRACE_BASE_URL (default http://localhost:4004),
//   BATCH_ID (reuse an existing minted batch), AUTH_HEADER, POLL_TIMEOUT_MS.

import { sign } from "./signer.mjs";

const BASE = process.env.TRACE_BASE_URL ?? "http://localhost:4004";
const SVC = `${BASE}/odata/v4/trace`;
const DRY = process.argv.includes("--dry-run");
const ADDR = req("WALLET_ADDRESS");
const VKH = req("WALLET_VKH");
const POLL_TIMEOUT = Number(process.env.POLL_TIMEOUT_MS ?? 180_000);
const HEADERS = { "Content-Type": "application/json", ...(process.env.AUTH_HEADER ? { Authorization: process.env.AUTH_HEADER } : {}) };

function req(name) {
    const v = process.env[name];
    if (!v) { console.error(`Missing required env ${name}`); process.exit(2); }
    return v;
}
function log(...a) { console.log(...a); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function call(method, path, body) {
    const res = await fetch(`${SVC}${path}`, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json?.error?.message ?? text}`);
    return json;
}
const action = (name, data) => call("POST", `/${name}`, data);

// Build → sign → submit. Returns the submit result. In --dry-run, prints the
// unsigned tx and returns null (caller should stop).
async function signAndSubmit(label, build) {
    log(`  built ${label}: buildId=${build.buildId} sigReq=${build.signingRequestId}`);
    if (DRY) {
        log(`  [dry-run] txBodyHash=${build.txBodyHash}`);
        log(`  [dry-run] unsignedTxCbor=${(build.unsignedCbor ?? "").slice(0, 80)}…`);
        return null;
    }
    const witness = sign(build.unsignedCbor, build.txBodyHash);
    const submit = await action("SubmitSigned", { signingRequestId: build.signingRequestId, signedTxCbor: witness });
    log(`  submitted ${label}: txHash=${submit.txHash}`);
    return submit;
}

// Poll CheckPendingTransactions until `check()` (a GET-based predicate) is true.
async function pollUntil(label, check) {
    const deadline = Date.now() + POLL_TIMEOUT;
    while (Date.now() < deadline) {
        const r = await action("CheckPendingTransactions", {});
        if (await check()) { log(`  confirmed ${label} (checked=${r.checked} confirmed=${r.confirmed})`); return; }
        await sleep(5000);
    }
    throw new Error(`Timed out waiting for ${label} to confirm`);
}

async function getMonitor(id) {
    const r = await call("GET", `/ConditionMonitors(${id})`);
    return r;
}

async function main() {
    log(`TRACE cold-chain E2E → ${SVC}  (${DRY ? "DRY-RUN" : "FULL SUBMIT"})`);

    // --- 0. preconditions: a minted, confirmed batch to monitor ---
    let batchId = process.env.BATCH_ID;
    if (!batchId) {
        throw new Error("Set BATCH_ID to a CONFIRMED minted batch. Mint one via the " +
            "InitManufacturerCounter → create Batch → MintBatchNft flow first " +
            "(see README), then re-run with BATCH_ID set.");
    }
    log(`\n[1/5] Using batch ${batchId}`);

    // --- 1. InitColdChainMonitor (2..8 °C fridge spec) ---
    log(`\n[2/5] InitColdChainMonitor`);
    const init = await action("InitColdChainMonitor",
        { batchId, minMilliC: 2000, maxMilliC: 8000, walletAddress: ADDR, walletVkh: VKH });
    const monitorId = init.monitorId;
    log(`  monitorId=${monitorId} policyId=${init.policyId}`);
    if (!(await signAndSubmit("InitColdChainMonitor", init))) { log("dry-run stop"); return; }
    await pollUntil("monitor init", async () => (await getMonitor(monitorId)).status === "CONFIRMED");

    // --- 2. RecordSensorReadings — clean (all in spec) ---
    log(`\n[3/5] RecordSensorReadings (in-spec)`);
    const now = Date.now();
    const clean = await action("RecordSensorReadings", {
        monitorId, walletAddress: ADDR, walletVkh: VKH,
        readingsJson: JSON.stringify([
            { metric: "TEMPERATURE", milliValue: 4200, recordedAt: new Date(now).toISOString() },
            { metric: "TEMPERATURE", milliValue: 6100, recordedAt: new Date(now + 3600e3).toISOString() },
        ]),
    });
    log(`  newReadingCount=${clean.newReadingCount} breached=${clean.breached}`);
    await signAndSubmit("RecordReadings(clean)", clean);
    await pollUntil("clean readings", async () => (await getMonitor(monitorId)).readingCount >= 2);

    // --- 3. RecordSensorReadings — breach (out of spec → quarantine) ---
    log(`\n[4/5] RecordSensorReadings (BREACH)`);
    const breach = await action("RecordSensorReadings", {
        monitorId, walletAddress: ADDR, walletVkh: VKH,
        readingsJson: JSON.stringify([
            { metric: "TEMPERATURE", milliValue: 15000, recordedAt: new Date(now + 7200e3).toISOString() },
        ]),
    });
    log(`  newBreachCount=${breach.newBreachCount} breached=${breach.breached}`);
    await signAndSubmit("RecordReadings(breach)", breach);
    await pollUntil("breach readings", async () => (await getMonitor(monitorId)).breached === true);

    // --- 4. VerifyBatch — public read must show the breach ---
    log(`\n[5/5] VerifyBatch`);
    const verify = await call("GET", `/VerifyBatch(batchIdOrFingerprint='${batchId}')`);
    log(`  coldChain=${JSON.stringify(verify.coldChain)}  isValid=${verify.isValid}`);
    if (!verify.coldChain?.breached) throw new Error("VerifyBatch did not report the breach!");
    if (verify.isValid !== false) throw new Error("VerifyBatch.isValid should be false after a breach!");

    // --- 5. CloseColdChainMonitor ---
    log(`\nClosing monitor`);
    const close = await action("CloseColdChainMonitor", { monitorId, walletAddress: ADDR, walletVkh: VKH });
    await signAndSubmit("CloseColdChainMonitor", close);
    await pollUntil("monitor close", async () => (await getMonitor(monitorId)).status === "CLOSED");

    log(`\n✅ Cold-chain E2E complete: monitor breached, batch quarantined, verified, closed.`);
}

main().catch(e => { console.error(`\n❌ ${e.message}`); process.exit(1); });
