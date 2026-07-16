// Reference CIP-30-style witness-set signer for the testnet driver.
//
// Signs the build's `txBodyHash` (blake2b-256 of the tx body) with an ed25519
// key and returns a CBOR witness set hex: { 0: [ [vkey, signature] ] } — the
// shape ODATANO's SubmitVerifiedTransaction expects from a CIP-30 wallet.
//
// ⚠️  UNVERIFIED against a live ODATANO/Buildooor round-trip. It is the single
//     integration point most likely to need adjustment. For the authoritative
//     run prefer a real CIP-30 wallet; use this only for an automated smoke.
//
// Key material: WALLET_SKEY_HEX = 32-byte ed25519 seed (hex). NEVER commit it;
// pass via env. The derived public key's hash must equal WALLET_VKH.

import crypto from "node:crypto";

// PKCS8 DER prefix for a raw 32-byte ed25519 seed.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function privFromSeed(seedHex) {
    const seed = Buffer.from(seedHex, "hex");
    if (seed.length !== 32) throw new Error(`WALLET_SKEY_HEX must be 32 bytes, got ${seed.length}`);
    return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

function pubFromPriv(priv) {
    // SPKI DER = 12-byte prefix + 32-byte raw public key.
    return crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
}

// CBOR-encode a byte string (definite length, < 2^16 bytes is plenty here).
function cborBytes(buf) {
    if (buf.length < 24) return Buffer.concat([Buffer.from([0x40 | buf.length]), buf]);
    if (buf.length < 256) return Buffer.concat([Buffer.from([0x58, buf.length]), buf]);
    const h = Buffer.alloc(3); h[0] = 0x59; h.writeUInt16BE(buf.length, 1);
    return Buffer.concat([h, buf]);
}

/**
 * @param {string} _unsignedTxCbor  the unsigned tx (unused here; the witness
 *        signs the body hash, which ODATANO re-derives and compares).
 * @param {string} txBodyHash  hex blake2b-256 of the tx body.
 * @returns {string} hex of the CBOR TransactionWitnessSet { 0: [[vkey, sig]] }.
 */
export function sign(_unsignedTxCbor, txBodyHash) {
    const seedHex = process.env.WALLET_SKEY_HEX;
    if (!seedHex) throw new Error("WALLET_SKEY_HEX not set — cannot sign (or run with --dry-run)");
    const priv = privFromSeed(seedHex);
    const pub = pubFromPriv(priv);
    const msg = Buffer.from(txBodyHash, "hex");
    const sig = crypto.sign(null, msg, priv); // ed25519 → 64-byte signature

    // witness set: map(1) { 0 => array(1) [ array(2) [ vkey, sig ] ] }
    const vkeyWitness = Buffer.concat([Buffer.from([0x82]), cborBytes(pub), cborBytes(sig)]);
    const witnessSet = Buffer.concat([
        Buffer.from([0xa1, 0x00, 0x81]), // {0: [ ...1 item... ]}
        vkeyWitness,
    ]);
    return witnessSet.toString("hex");
}
