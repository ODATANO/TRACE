import cds from '@sap/cds';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlutusValidator { title: string; compiledCode: string }
interface PlutusJson { validators: PlutusValidator[] }

export interface MintParams {
  senderAddress: string;
  manufacturerVkh: string;
  batchId: string;
  originDigest: string;
}

export interface MintResult {
  buildId: string;
  unsignedCbor: string;
  txBodyHash: string;
  policyId: string;
  assetName: string;
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

export function buildTransferRedeemer(nextHolderVkh: string): string {
  return JSON.stringify({
    constructor: 0,
    fields: [{ bytes: nextHolderVkh }]
  });
}

export function buildDeliverRedeemer(): string {
  return JSON.stringify({ constructor: 1, fields: [] });
}

export function toHex(str: string): string {
  return Buffer.from(str, 'utf8').toString('hex');
}

// ---------------------------------------------------------------------------
// Public ChainAdapter API — via ODATANO CDS services
// ---------------------------------------------------------------------------

/**
 * Mint a batch NFT on Cardano.
 *
 * Uses ODATANO v0.3.12 `lockOnScript` to route the NFT output to the
 * enterprise script address automatically. No two-pass build needed.
 */
export async function mintBatchNft(params: MintParams): Promise<MintResult> {

  const srv = await txSrv();
  const validatorHex = getValidatorHex('pharma_trace.pharma_trace.mint');
  const batchIdHex = toHex(params.batchId);

  const datum = buildChainOfCustodyDatum(
    params.manufacturerVkh,
    params.manufacturerVkh,
    batchIdHex,
    0
  );

  const build = await srv.send('BuildMintTransaction', {
    senderAddress: params.senderAddress,
    recipientAddress: params.senderAddress,
    lovelaceAmount: '2500000',
    mintActionsJson: JSON.stringify([{ assetUnit: batchIdHex, quantity: '1' }]),
    mintingPolicyScript: validatorHex,
    scriptParamsJson: JSON.stringify([{ bytes: params.manufacturerVkh }]),
    changeAddress: params.senderAddress,
    requiredSignersJson: JSON.stringify([params.manufacturerVkh]),
    inlineDatumJson: datum,
    lockOnScript: true
  });

  return {
    buildId: build.id,
    unsignedCbor: build.unsignedTxCbor,
    txBodyHash: build.txBodyHash,
    policyId: build.scriptHash,
    assetName: batchIdHex,
    fingerprint: build.fingerprint ?? '',
    scriptAddress: build.scriptAddress,
    datum
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

  const redeemer = buildTransferRedeemer(params.nextHolderVkh);

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
    scriptParamsJson: JSON.stringify([{ bytes: params.manufacturerVkh }]),
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
    scriptParamsJson: JSON.stringify([{ bytes: params.manufacturerVkh }]),
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

  const result = await srv.send('SubmitVerifiedTransaction', {
    signingRequestId,
    signedTxCbor: walletWitnessCbor
  });
  return {
    txHash: result.txHash,
    submissionId: result.id,
    status: result.status
  };
}

/**
 * Check the confirmation status of a previously submitted transaction.
 */
export async function checkSubmissionStatus(submissionId: string): Promise<SubmissionStatus> {
  const srv = await txSrv();
  try {
    const result = await srv.send({
      event: 'CheckSubmissionStatus',
      data: {},
      params: [{ id: submissionId }]
    });
    return {
      status: result.status ?? 'submitted',
      txHash: result.txHash ?? null,
      errorMessage: result.errorMessage ?? null
    };
  } catch (err: any) {
    return {
      status: 'failed',
      txHash: null,
      errorMessage: err.message ?? 'Unknown error checking submission status'
    };
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
  // Trigger address indexing — GetAddressByBech32 fetches from blockchain on cache miss
  await srv.send('GetAddressByBech32', { address: walletAddress });
  return srv.send('GetAssetsByAddress', { address: walletAddress });
}

/**
 * Query the confirmation status of a submitted transaction.
 */
export async function getTxStatus(txHash: string): Promise<TxStatus> {
  const srv = await oDataSrv();
  try {
    const result = await srv.send('GetTransactionByHash', { hash: txHash });
    return { status: 'confirmed', block: result?.blockHash ?? null, slot: result?.slot ?? null };
  } catch (err: any) {
    if (err.code === 404 || err.status === 404) {
      return { status: 'pending', block: null, slot: null };
    }
    throw err;
  }
}
