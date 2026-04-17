import cds from '@sap/cds';
import fs from 'fs';
import path from 'path';

const LOG = cds.log('chain-adapter');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlutusValidator { title: string; compiledCode: string }
interface PlutusJson { validators: PlutusValidator[] }

export interface CounterState {
  policyId: string;
  scriptAddress: string;
  seedTxHash: string;
  seedIdx: number;
  currentN: number;
  counterTxHash: string;
  counterIdx: number;
}

export interface MintParams {
  senderAddress: string;
  manufacturerVkh: string;
  batchId: string;      // human-facing batch number, audit only; on-chain name is intToBytes(n+1)
  originDigest: string;
  counter: CounterState;
}

export interface InitCounterParams {
  senderAddress: string;
  manufacturerVkh: string;
  seedTxHash: string;
  seedIdx: number;
}

export interface InitCounterResult {
  buildId: string;
  unsignedCbor: string;
  txBodyHash: string;
  policyId: string;
  scriptAddress: string;
  seedTxHash: string;
  seedIdx: number;
}

export interface MintResult {
  buildId: string;
  unsignedCbor: string;
  txBodyHash: string;
  policyId: string;
  assetName: string;       // hex-encoded intToBytes(n) — on-chain asset name
  batchNumberOnChain: number;
  fingerprint: string;
  scriptAddress: string;
  datum: string;
}

export interface TransferParams {
  senderAddress: string;
  manufacturerVkh: string;
  currentHolderVkh: string;
  nextHolderVkh: string;
  batchIdHex: string;
  currentStep: number;
  scriptTxHash: string;
  scriptOutputIndex: number;
  seedTxHash: string;
  seedIdx: number;
}

export interface TransferResult {
  buildId: string;
  unsignedCbor: string;
  txBodyHash: string;
}

export interface DeliverParams {
  senderAddress: string;
  manufacturerVkh: string;
  currentHolderVkh: string;
  batchIdHex: string;
  currentStep: number;
  scriptTxHash: string;
  scriptOutputIndex: number;
  seedTxHash: string;
  seedIdx: number;
}

export interface SigningRequestResult {
  signingRequestId: string;
  unsignedTxCbor: string;
  txBodyHash: string;
}

export interface SubmitResult {
  txHash: string;
  submissionId: string;
  status: string;
}

export interface SubmissionStatus {
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  txHash: string | null;
  errorMessage: string | null;
}

export interface RegisterParams {
  senderAddress: string;
  registrantVkh: string;
}

export interface RegisterForOtherParams {
  senderAddress: string;    // current user's wallet (pays fee, signs)
  senderVkh: string;        // current user's VKH (script param + required signer)
  recipientAddress: string; // new participant's wallet (receives NFT)
}

export interface RegisterResult {
  buildId: string;
  unsignedCbor: string;
  txBodyHash: string;
  policyId: string;
}

export interface AnchorParams {
  senderAddress: string;
  documentHash: string;
  metadataJson: string;
}

export interface AnchorResult {
  buildId: string;
  unsignedCbor: string;
  txBodyHash: string;
}

export interface TxStatus {
  status: 'pending' | 'confirmed' | 'failed';
  block: string | null;
  slot: number | null;
}

// ---------------------------------------------------------------------------
// Lazy CDS service connections
// ---------------------------------------------------------------------------

let _txSrv: any;
let _oDataSrv: any;
let _signSrv: any;

async function txSrv() {
  if (!_txSrv) _txSrv = await cds.connect.to('CardanoTransactionService');
  return _txSrv;
}

async function oDataSrv() {
  if (!_oDataSrv) _oDataSrv = await cds.connect.to('CardanoODataService');
  return _oDataSrv;
}

async function signSrv() {
  if (!_signSrv) _signSrv = await cds.connect.to('CardanoSignService');
  return _signSrv;
}

// ---------------------------------------------------------------------------
// Plutus validator loading
// ---------------------------------------------------------------------------

let _plutusJson: PlutusJson | null = null;

function getPlutusJson(): PlutusJson {
  if (!_plutusJson) {
    const filePath = path.resolve(__dirname, '../../contracts/plutus.json');
    _plutusJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return _plutusJson!;
}

export function getValidatorHex(title: string): string {
  const plutus = getPlutusJson();
  const validator = plutus.validators.find(v => v.title === title);
  if (!validator) throw new Error(`Validator "${title}" not found in plutus.json`);
  return validator.compiledCode;
}

// ---------------------------------------------------------------------------
// Datum / Redeemer builders (cardano-cli DetailedSchema JSON)
// ---------------------------------------------------------------------------

export function buildChainOfCustodyDatum(
  manufacturerVkh: string,
  currentHolderVkh: string,
  batchIdHex: string,
  step: number
): string {
  return JSON.stringify({
    constructor: 0,
    fields: [
      { bytes: manufacturerVkh },
      { bytes: currentHolderVkh },
      { bytes: batchIdHex },
      { int: step }
    ]
  });
}

// Validator ABI: Transfer { input_idx: Int, output_idx: Int }.
// input_idx is resolved by ODATANO (v1.2.0 __INPUT_IDX:... placeholder) to the
// lexicographically-sorted position of the script UTxO. output_idx = 0 because
// the continuing output is always the primary one (ODATANO appends extras/change after).
export function buildTransferRedeemer(scriptTxHash: string, scriptOutputIndex: number): string {
  return JSON.stringify({
    constructor: 0,
    fields: [
      { int: `__INPUT_IDX:${scriptTxHash}#${scriptOutputIndex}__` },
      { int: 0 }
    ]
  });
}

export function buildDeliverRedeemer(): string {
  return JSON.stringify({ constructor: 1, fields: [] });
}

export function toHex(str: string): string {
  return Buffer.from(str, 'utf8').toString('hex');
}

// ---------------------------------------------------------------------------
// Shared builders for the counter-pattern ABI (Aiken + Pebble)
// Aiken indices: Datum ChainOfCustody=0, MintCounter=1.
// Mint redeemer: InitCounter=0, MintBatch=1, Burn=2.
// Spend redeemer: Transfer=0, Deliver=1, IncrementCounter=2.
// Script params: (manufacturer: VKH, seed: OutputReference).
// ---------------------------------------------------------------------------

export const COUNTER_ASSET_NAME_HEX = '';

// Minimal big-endian encoding — mirrors Aiken `int_to_bytes`:
//   0 -> ""           (empty — reserved for counter, not batches)
//   1 -> "01"
//   256 -> "0100"
export function intToBytes(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`intToBytes: ${n} must be a non-negative integer`);
  if (n === 0) return '';
  let hex = '';
  let v = n;
  while (v > 0) {
    hex = (v % 256).toString(16).padStart(2, '0') + hex;
    v = Math.floor(v / 256);
  }
  return hex;
}

export function buildMintCounterDatum(manufacturerVkh: string, n: number): string {
  return JSON.stringify({
    constructor: 1,
    fields: [{ bytes: manufacturerVkh }, { int: n }]
  });
}

export function buildInitCounterRedeemer(): string {
  return JSON.stringify({ constructor: 0, fields: [] });
}

export function buildMintBatchRedeemer(counterInputIdx: number): string {
  return JSON.stringify({ constructor: 1, fields: [{ int: counterInputIdx }] });
}

export function buildBurnRedeemer(): string {
  return JSON.stringify({ constructor: 2, fields: [] });
}

export function buildIncrementCounterRedeemer(ownInputIdx: number): string {
  return JSON.stringify({ constructor: 2, fields: [{ int: ownInputIdx }] });
}

// scriptParamsJson for the parameterised validator: [mfrVkh, seed OutputReference].
// OutputReference = Constr 0 { transaction_id: ByteArray, output_index: Int }.
export function buildScriptParams(manufacturerVkh: string, seedTxHash: string, seedIdx: number): string {
  return JSON.stringify([
    { bytes: manufacturerVkh },
    { constructor: 0, fields: [{ bytes: seedTxHash }, { int: seedIdx }] }
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a callback against a CDS service, using the current request's user
 * context when available (avoids nested SQLite transactions / deadlocks).
 * Falls back to cds.User.privileged for background contexts (e.g. polling).
 */
async function srvRun<T>(srv: any, fn: (s: any) => Promise<T>): Promise<T> {
  if (cds.context?.user) return fn(srv);
  return srv.tx({ user: cds.User.privileged }, (tx: any) => fn(tx));
}

/**
 * Find the output index of a confirmed transaction at a given address.
 * Falls back to 0 if the address is not found in the outputs.
 */
export async function getScriptOutputIndex(txHash: string, scriptAddress: string): Promise<number> {
  try {
    const srv = await oDataSrv();
    return await srvRun(srv, async (s: any) => {
      const result = await s.send('GetTransactionByHash', { hash: txHash });
      if (result?.outputs) {
        for (const out of result.outputs) {
          if (out.address === scriptAddress) return out.outputIndex ?? 0;
        }
      }
      return 0;
    });
  } catch (err: any) {
    // Fallback — tx not yet indexed or address not found
    return 0;
  }
}

/**
 * Find the output index of a confirmed transaction whose value contains a
 * specific asset `policyId + assetNameHex` (at any quantity ≥ 1). Returns
 * `null` if not found (tx not indexed yet, or asset absent).
 */
export async function getAssetOutputIndex(
  txHash: string,
  policyId: string,
  assetNameHex: string
): Promise<number | null> {
  try {
    const srv = await oDataSrv();
    return await srvRun(srv, async (s: any) => {
      const result = await s.send('GetTransactionByHash', { hash: txHash });
      if (!result?.outputs) return null;
      for (const out of result.outputs) {
        const assets = out.assets ?? out.amount ?? [];
        for (const a of assets) {
          const unit = a.unit ?? ((a.policyId ?? '') + (a.assetName ?? ''));
          if (unit === policyId + assetNameHex) {
            return out.outputIndex ?? null;
          }
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public ChainAdapter API — via ODATANO CDS services
// ---------------------------------------------------------------------------

/**
 * Pick a wallet UTxO to use as the one-shot seed for InitCounter.
 * Returns the first pure-ADA UTxO with >= minLovelace; falls back to the first UTxO.
 */
export async function pickSeedUtxo(
  walletAddress: string,
  minLovelace: bigint = 3_000_000n
): Promise<{ txHash: string; outputIndex: number }> {
  const { getCardanoClient } = await import('@odatano/core');
  const client = getCardanoClient();
  const addrData: any = await client.getAddress(walletAddress);
  const utxos: any[] = addrData?.utxos ?? [];

  if (!utxos.length) {
    throw new Error(`No UTxOs at ${walletAddress} — fund the wallet before InitCounter`);
  }

  const pureAda = utxos.find(u => {
    const amounts: any[] = u.amount ?? [];
    const lovelaceEntry = amounts.find(a => a.unit === 'lovelace');
    const hasOnlyLovelace = amounts.length === 1 && !!lovelaceEntry;
    const lovelace = BigInt(lovelaceEntry?.quantity ?? 0);
    return hasOnlyLovelace && lovelace >= minLovelace;
  });
  const chosen = pureAda ?? utxos[0];

  const txHash = chosen.txHash ?? chosen.transactionHash ?? chosen.tx_hash ?? chosen.hash;
  const outputIndex = chosen.outputIndex ?? chosen.tx_index ?? chosen.index ?? 0;
  if (!txHash) throw new Error(`Seed UTxO has no txHash field: ${JSON.stringify(chosen)}`);
  return { txHash, outputIndex: Number(outputIndex) };
}

/**
 * Initialise the per-manufacturer counter NFT (one-shot mint).
 *
 * Consumes `seedTxHash#seedIdx` as a forced input (guaranteeing the script is
 * parameterised by a unique OutputReference → unique policy). Mints the counter
 * NFT with empty asset name and `MintCounter { n: 0 }` inline datum, locks it
 * at the script address.
 */
export async function initCounter(params: InitCounterParams): Promise<InitCounterResult> {
  const srv = await txSrv();
  const validatorHex = getValidatorHex('pharma_trace.pharma_trace.mint');

  const datum = buildMintCounterDatum(params.manufacturerVkh, 0);
  const redeemer = buildInitCounterRedeemer();
  const scriptParams = buildScriptParams(params.manufacturerVkh, params.seedTxHash, params.seedIdx);

  const build = await srv.send('BuildMintTransaction', {
    senderAddress: params.senderAddress,
    recipientAddress: params.senderAddress,
    lovelaceAmount: '2500000',
    mintActionsJson: JSON.stringify([{ assetUnit: COUNTER_ASSET_NAME_HEX, quantity: '1' }]),
    mintingPolicyScript: validatorHex,
    scriptParamsJson: scriptParams,
    mintRedeemerJson: redeemer,
    inlineDatumJson: datum,
    lockOnScript: true,
    forceInputsJson: JSON.stringify([{ txHash: params.seedTxHash, outputIndex: params.seedIdx }]),
    changeAddress: params.senderAddress,
    requiredSignersJson: JSON.stringify([params.manufacturerVkh])
  });

  return {
    buildId: build.id,
    unsignedCbor: build.unsignedTxCbor,
    txBodyHash: build.txBodyHash,
    policyId: build.scriptHash,
    scriptAddress: build.scriptAddress,
    seedTxHash: params.seedTxHash,
    seedIdx: params.seedIdx
  };
}

/**
 * Mint a batch NFT — counter-pattern flow.
 *
 * Atomically spends the current counter UTxO with IncrementCounter (Constr 2)
 * and mints the next batch NFT with MintBatch (Constr 1). The new counter
 * UTxO (with incremented n) is the primary output at the script address; the
 * batch NFT is an extra output also at the script address, carrying a
 * ChainOfCustody inline datum.
 *
 * On-chain asset name is `intToBytes(currentN + 1)` — enforced by the
 * validator. The caller's batchId string is a human-facing batch number
 * stored only in the TRACE DB for display/audit.
 */
export async function mintBatchNft(params: MintParams): Promise<MintResult> {
  const srv = await txSrv();
  const validatorHex = getValidatorHex('pharma_trace.pharma_trace.spend');

  const nextN = params.counter.currentN + 1;
  const batchNameHex = intToBytes(nextN);

  const scriptParams = buildScriptParams(
    params.manufacturerVkh,
    params.counter.seedTxHash,
    params.counter.seedIdx
  );

  const newCounterDatum = buildMintCounterDatum(params.manufacturerVkh, nextN);
  const batchDatum = buildChainOfCustodyDatum(
    params.manufacturerVkh,
    params.manufacturerVkh,
    batchNameHex,
    0
  );

  // __INPUT_IDX:<txHash>#<idx>__ is resolved by ODATANO v1.2.0 to the final
  // lexicographic input position after coin selection.
  const counterInputPlaceholder =
    `__INPUT_IDX:${params.counter.counterTxHash}#${params.counter.counterIdx}__`;

  const spendRedeemer = JSON.stringify({
    constructor: 2,
    fields: [{ int: counterInputPlaceholder }]
  });
  const mintRedeemer = JSON.stringify({
    constructor: 1,
    fields: [{ int: counterInputPlaceholder }]
  });

  const build = await srv.send('BuildPlutusSpendTransaction', {
    senderAddress: params.senderAddress,
    recipientAddress: params.senderAddress,
    lovelaceAmount: '2500000', // new counter UTxO
    validatorScript: validatorHex,
    scriptParamsJson: scriptParams,
    scriptTxHash: params.counter.counterTxHash,
    scriptOutputIndex: params.counter.counterIdx,
    redeemerJson: spendRedeemer,
    inlineDatumJson: newCounterDatum,
    lockOnScript: true,

    // Combined mint (v1.2.0). Pass full assetUnit (policyId+assetName) —
    // ODATANO's assetName-only expansion (BUG 7 fix) only runs in BuildMintTransaction,
    // not in BuildPlutusSpendTransaction's combined spend+mint path.
    mintActionsJson: JSON.stringify([{ assetUnit: params.counter.policyId + batchNameHex, quantity: '1' }]),
    mintingPolicyScript: validatorHex,
    mintRedeemerJson: mintRedeemer,

    // Batch NFT at script address with ChainOfCustody inline datum
    extraOutputsJson: JSON.stringify([{
      address: params.counter.scriptAddress,
      lovelaceAmount: '2000000',
      assets: [{ unit: params.counter.policyId + batchNameHex, quantity: '1' }],
      inlineDatumJson: batchDatum
    }]),

    changeAddress: params.senderAddress,
    requiredSignersJson: JSON.stringify([params.manufacturerVkh])
  });

  return {
    buildId: build.id,
    unsignedCbor: build.unsignedTxCbor,
    txBodyHash: build.txBodyHash,
    policyId: params.counter.policyId,
    assetName: batchNameHex,
    batchNumberOnChain: nextN,
    fingerprint: build.fingerprint ?? '',
    scriptAddress: params.counter.scriptAddress,
    datum: batchDatum
  };
}

/**
 * Mint a registration NFT for a new participant.
 *
 * Reuses the pharma_trace.pharma_trace.mint validator parameterized with the
 * registrant's VKH. Each VKH produces a unique policyId, making the
 * registration NFT (policyId + "REGISTRATION") globally unique.
 *
 * NFT goes to the participant's wallet (no lockOnScript, no datum).
 */
export async function mintRegistrationNft(params: RegisterParams): Promise<RegisterResult> {

  const srv = await txSrv();
  const validatorHex = getValidatorHex('pharma_trace.pharma_trace.mint');
  const assetNameHex = toHex('REGISTRATION');

  const build = await srv.send('BuildMintTransaction', {
    senderAddress: params.senderAddress,
    recipientAddress: params.senderAddress,
    lovelaceAmount: '2000000',
    mintActionsJson: JSON.stringify([{ assetUnit: assetNameHex, quantity: '1' }]),
    mintingPolicyScript: validatorHex,
    scriptParamsJson: JSON.stringify([{ bytes: params.registrantVkh }]),
    changeAddress: params.senderAddress,
    requiredSignersJson: JSON.stringify([params.registrantVkh])
  });

  return {
    buildId: build.id,
    unsignedCbor: build.unsignedTxCbor,
    txBodyHash: build.txBodyHash,
    policyId: build.scriptHash
  };
}

/**
 * Mint a registration NFT on behalf of another participant.
 *
 * The sender (current user) signs and pays, but the NFT is sent to the
 * recipient's wallet. The validator is parameterized with the sender's VKH
 * (required signer constraint), so the policyId reflects who issued the NFT.
 */
export async function mintRegistrationNftFor(params: RegisterForOtherParams): Promise<RegisterResult> {

  const srv = await txSrv();
  const validatorHex = getValidatorHex('pharma_trace.pharma_trace.mint');
  const assetNameHex = toHex('REGISTRATION');

  const build = await srv.send('BuildMintTransaction', {
    senderAddress: params.senderAddress,
    recipientAddress: params.recipientAddress,
    lovelaceAmount: '2000000',
    mintActionsJson: JSON.stringify([{ assetUnit: assetNameHex, quantity: '1' }]),
    mintingPolicyScript: validatorHex,
    scriptParamsJson: JSON.stringify([{ bytes: params.senderVkh }]),
    changeAddress: params.senderAddress,
    requiredSignersJson: JSON.stringify([params.senderVkh])
  });

  return {
    buildId: build.id,
    unsignedCbor: build.unsignedTxCbor,
    txBodyHash: build.txBodyHash,
    policyId: build.scriptHash
  };
}

/**
 * Build a spend transaction to transfer batch custody.
 * Uses ODATANO v0.3.12 `lockOnScript` to re-lock the NFT at the script address.
 */
export async function transferBatch(params: TransferParams): Promise<TransferResult> {

  const srv = await txSrv();
  const validatorHex = getValidatorHex('pharma_trace.pharma_trace.spend');

  const redeemer = buildTransferRedeemer(params.scriptTxHash, params.scriptOutputIndex);

  // Output datum: updated state for the continuing output
  const outputDatum = buildChainOfCustodyDatum(
    params.manufacturerVkh,
    params.nextHolderVkh,
    params.batchIdHex,
    params.currentStep + 1
  );

  // NOTE: No datumJson — the UTxO has an inline datum on-chain.
  // Omitting datumJson makes Buildooor use "inline" mode, reading the datum
  // directly from the UTxO instead of the witness set.
  const build = await srv.send('BuildPlutusSpendTransaction', {
    senderAddress: params.senderAddress,
    recipientAddress: params.senderAddress,
    lovelaceAmount: '2500000',
    validatorScript: validatorHex,
    scriptParamsJson: buildScriptParams(params.manufacturerVkh, params.seedTxHash, params.seedIdx),
    scriptTxHash: params.scriptTxHash,
    scriptOutputIndex: params.scriptOutputIndex,
    redeemerJson: redeemer,
    inlineDatumJson: outputDatum,
    changeAddress: params.senderAddress,
    requiredSignersJson: JSON.stringify([params.currentHolderVkh]),
    lockOnScript: true
  });

  return {
    buildId: build.id,
    unsignedCbor: build.unsignedTxCbor,
    txBodyHash: build.txBodyHash
  };
}

/**
 * Build a spend transaction to deliver the batch NFT.
 * The NFT leaves the script address and goes to the current holder's wallet,
 * making it permanently non-transferable through the validator.
 */
export async function deliverBatch(params: DeliverParams): Promise<TransferResult> {

  const srv = await txSrv();
  const validatorHex = getValidatorHex('pharma_trace.pharma_trace.spend');

  const redeemer = buildDeliverRedeemer();

  // No inlineDatumJson — wallet output doesn't need datum
  // No lockOnScript — NFT goes to wallet, not back to script
  const build = await srv.send('BuildPlutusSpendTransaction', {
    senderAddress: params.senderAddress,
    recipientAddress: params.senderAddress,
    lovelaceAmount: '2500000',
    validatorScript: validatorHex,
    scriptParamsJson: buildScriptParams(params.manufacturerVkh, params.seedTxHash, params.seedIdx),
    scriptTxHash: params.scriptTxHash,
    scriptOutputIndex: params.scriptOutputIndex,
    redeemerJson: redeemer,
    changeAddress: params.senderAddress,
    requiredSignersJson: JSON.stringify([params.currentHolderVkh])
  });

  return {
    buildId: build.id,
    unsignedCbor: build.unsignedTxCbor,
    txBodyHash: build.txBodyHash
  };
}

/**
 * Create a signing request for external (CIP-30) signing.
 */
export async function createSigningRequest(buildId: string): Promise<SigningRequestResult> {
  const srv = await signSrv();
  const result = await srv.send('CreateSigningRequest', { buildId });
  return {
    signingRequestId: result.id,
    unsignedTxCbor: result.unsignedTxCbor,
    txBodyHash: result.txBodyHash
  };
}

/**
 * Submit a CIP-30 wallet witness set for a previously built transaction.
 * Uses ODATANO's SubmitVerifiedTransaction, which re-builds the transaction and compares the tx body hash before submitting.
 */
export async function submitSigned(signingRequestId: string, walletWitnessCbor: string): Promise<SubmitResult> {
  const srv = await signSrv();

  try {
    const result = await srv.send('SubmitVerifiedTransaction', {
      signingRequestId,
      signedTxCbor: walletWitnessCbor
    });
    return {
      txHash: result.txHash,
      submissionId: result.id,
      status: result.status
    };
  } catch (err: any) {
    // "All inputs are spent / already been included" means the TX is already on-chain
    const msg = err.message || '';
    if (msg.includes('already been included') || msg.includes('All inputs are spent')) {
      LOG.warn('TX already on-chain, treating as success:', msg);
      // Retrieve the txBodyHash from the signing request as fallback txHash
      const sigReq = await srv.send('READ', { path: `SigningRequests('${signingRequestId}')` }).catch(() => null);
      return {
        txHash: sigReq?.txBodyHash || signingRequestId,
        submissionId: signingRequestId,
        status: 'submitted'
      };
    }
    throw err;
  }
}

/**
 * Check the confirmation status of a previously submitted transaction.
 */
export async function checkSubmissionStatus(submissionId: string): Promise<SubmissionStatus> {
  const srv = await txSrv();
  try {
    return await srvRun(srv, async (s: any) => {
      const result = await s.send({
        event: 'CheckSubmissionStatus',
        data: {},
        params: [{ id: submissionId }]
      });
      return {
        status: result.status ?? 'submitted',
        txHash: result.txHash ?? null,
        errorMessage: result.errorMessage ?? null
      } as SubmissionStatus;
    });
  } catch (err: any) {
    LOG.warn('CheckSubmissionStatus error for', submissionId, ':', err.message);
    return {
      status: 'unknown',
      txHash: null,
      errorMessage: err.message ?? 'Unknown error checking submission status'
    };
  }
}

/**
 * Check if a transaction hash exists on-chain (confirmed).
 * Runs as privileged user to bypass auth in background polling contexts.
 */
export async function isTxConfirmedOnChain(txHash: string): Promise<boolean> {
  try {
    const srv = await oDataSrv();
    return await srvRun(srv, async (s: any) => {
      const result = await s.send('GetTransactionByHash', { hash: txHash });
      return !!result?.blockHash;
    });
  } catch (err: any) {
    LOG.warn('On-chain TX check failed:', err.message);
    return false;
  }
}

/**
 * Build a metadata transaction to anchor a document hash on-chain.
 */
export async function anchorDocument(params: AnchorParams): Promise<AnchorResult> {

  const srv = await txSrv();
  const build = await srv.send('BuildTransactionWithMetadata', {
    senderAddress: params.senderAddress,
    recipientAddress: params.senderAddress,
    lovelaceAmount: '1500000',
    metadataJson: params.metadataJson,
    changeAddress: params.senderAddress
  });

  return {
    buildId: build.id,
    unsignedCbor: build.unsignedTxCbor,
    txBodyHash: build.txBodyHash
  };
}

/**
 * Query all native assets at a wallet address via ODATANO.
 * Triggers address indexing first (lazy on-demand), then queries assets.
 */
export async function getWalletAssets(walletAddress: string): Promise<any[]> {
  const srv = await oDataSrv();
  return srvRun(srv, async (s: any) => {
    // Trigger address indexing — GetAddressByBech32 fetches from blockchain on cache miss
    await s.send('GetAddressByBech32', { address: walletAddress });
    return s.send('GetAssetsByAddress', { address: walletAddress });
  });
}

/**
 * Query the confirmation status of a submitted transaction.
 */
export async function getTxStatus(txHash: string): Promise<TxStatus> {
  const srv = await oDataSrv();
  try {
    return await srvRun(srv, async (s: any) => {
      const result = await s.send('GetTransactionByHash', { hash: txHash });
      return { status: 'confirmed' as const, block: result?.blockHash ?? null, slot: result?.slot ?? null };
    });
  } catch (err: any) {
    if (err.code === 404 || err.status === 404) {
      return { status: 'pending', block: null, slot: null };
    }
    throw err;
  }
}
