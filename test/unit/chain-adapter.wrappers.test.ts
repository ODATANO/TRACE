/**
 * Unit tests for the wrapper functions in srv/lib/chain-adapter.ts that call
 * into ODATANO via CDS services (CardanoTransactionService, CardanoODataService,
 * CardanoSignService).
 *
 * Strategy: monkey-patch `cds.connect.to` to return fake services with a
 * jest.fn() `send` + a `tx` wrapper that just runs its callback with the same
 * fake service. That lets us assert *exactly* what payload each wrapper sends
 * to ODATANO without booting cds.test or talking to anything.
 *
 * pickSeedUtxo additionally requires `@odatano/core` to be mocked because it
 * imports getCardanoClient dynamically.
 */

jest.mock('@odatano/core', () => ({
  getCardanoClient: jest.fn(),
}));

import cds from '@sap/cds';
import { getCardanoClient } from '@odatano/core';
import * as chainAdapter from '../../srv/lib/chain-adapter';

// One fake per service. chain-adapter caches the first `connect.to` result per
// service name, so sharing these across the whole file matches its behaviour.
const fakeTxSrv:    any = { send: jest.fn(), tx: jest.fn((_: any, fn: any) => fn(fakeTxSrv)) };
const fakeODataSrv: any = { send: jest.fn(), tx: jest.fn((_: any, fn: any) => fn(fakeODataSrv)) };
const fakeSignSrv:  any = { send: jest.fn(), tx: jest.fn((_: any, fn: any) => fn(fakeSignSrv)) };

const origConnectTo = cds.connect.to.bind(cds.connect);

beforeAll(() => {
  (cds.connect as any).to = jest.fn(async (name: any) => {
    if (name === 'CardanoTransactionService') return fakeTxSrv;
    if (name === 'CardanoODataService')       return fakeODataSrv;
    if (name === 'CardanoSignService')        return fakeSignSrv;
    return origConnectTo(name);
  });
});

afterAll(() => {
  (cds.connect as any).to = origConnectTo;
});

beforeEach(() => {
  fakeTxSrv.send.mockReset();
  fakeODataSrv.send.mockReset();
  fakeSignSrv.send.mockReset();
  (getCardanoClient as jest.Mock).mockReset();
});

const VKH_MFR   = 'a'.repeat(56);
const VKH_HOLD  = 'b'.repeat(56);
const VKH_NEXT  = 'c'.repeat(56);
const SEED_TX   = 's'.repeat(64);
const SCRIPT_TX = 'd'.repeat(64);
const POLICY    = 'p'.repeat(56);
const ADDR      = 'addr_test1qq' + 'x'.repeat(99);
const SCRIPT_ADDR = 'addr_test1zz' + 'y'.repeat(99);

// ---------------------------------------------------------------------------
// Build wrappers
// ---------------------------------------------------------------------------

describe('initCounter', () => {
  it('builds a BuildMintTransaction with seed forced as input, counter datum, lockOnScript', async () => {
    fakeTxSrv.send.mockResolvedValue({
      id: 'b-init', unsignedTxCbor: 'cbor', txBodyHash: 'hash',
      scriptHash: POLICY, scriptAddress: SCRIPT_ADDR,
    });

    const result = await chainAdapter.initCounter({
      senderAddress: ADDR,
      manufacturerVkh: VKH_MFR,
      seedTxHash: SEED_TX,
      seedIdx: 3,
    });

    expect(result).toEqual({
      buildId: 'b-init',
      unsignedCbor: 'cbor',
      txBodyHash: 'hash',
      policyId: POLICY,
      scriptAddress: SCRIPT_ADDR,
      seedTxHash: SEED_TX,
      seedIdx: 3,
    });

    expect(fakeTxSrv.send).toHaveBeenCalledTimes(1);
    const [event, payload] = fakeTxSrv.send.mock.calls[0];
    expect(event).toBe('BuildMintTransaction');
    expect(payload.senderAddress).toBe(ADDR);
    expect(payload.recipientAddress).toBe(ADDR);
    expect(payload.lockOnScript).toBe(true);
    expect(payload.changeAddress).toBe(ADDR);
    expect(JSON.parse(payload.forceInputsJson)).toEqual([
      { txHash: SEED_TX, outputIndex: 3 },
    ]);
    expect(JSON.parse(payload.requiredSignersJson)).toEqual([VKH_MFR]);
    expect(JSON.parse(payload.mintActionsJson)).toEqual([
      { assetUnit: '', quantity: '1' },
    ]);
    // Inline datum is the MintCounter datum with n=0
    expect(JSON.parse(payload.inlineDatumJson)).toEqual({
      constructor: 1, fields: [{ bytes: VKH_MFR }, { int: 0 }],
    });
    // Script params: (mfrVkh, seed OutputReference).
    // `as any[]` because TS narrows the array element union from the literal
    // with `constructor: 0`, and the bare `{ bytes }` literal then conflicts
    // with the inherited Object.prototype `constructor: Function`.
    expect(JSON.parse(payload.scriptParamsJson)).toEqual([
      { bytes: VKH_MFR },
      { constructor: 0, fields: [{ bytes: SEED_TX }, { int: 3 }] },
    ] as any[]);
    // mintRedeemerJson = InitCounter (constr 0)
    expect(JSON.parse(payload.mintRedeemerJson)).toEqual({
      constructor: 0, fields: [],
    });
  });
});

describe('mintBatchNft', () => {
  it('builds a combined spend+mint with INPUT_IDX placeholders and ChainOfCustody extra output', async () => {
    fakeTxSrv.send.mockResolvedValue({
      id: 'b-mint', unsignedTxCbor: 'cbor', txBodyHash: 'hash',
      fingerprint: 'asset1zzz',
    });

    const result = await chainAdapter.mintBatchNft({
      senderAddress: ADDR,
      manufacturerVkh: VKH_MFR,
      batchId: 'B-001',
      originDigest: 'deadbeef',
      counter: {
        policyId: POLICY,
        scriptAddress: SCRIPT_ADDR,
        seedTxHash: SEED_TX,
        seedIdx: 0,
        currentN: 4,
        counterTxHash: SCRIPT_TX,
        counterIdx: 0,
      },
    });

    // n+1 → 5 → intToBytes(5) === '05'
    expect(result.assetName).toBe('05');
    expect(result.batchNumberOnChain).toBe(5);
    expect(result.policyId).toBe(POLICY);
    expect(result.scriptAddress).toBe(SCRIPT_ADDR);
    expect(result.buildId).toBe('b-mint');
    expect(result.fingerprint).toBe('asset1zzz');
    // datum returned is the ChainOfCustody datum
    expect(JSON.parse(result.datum)).toEqual({
      constructor: 0,
      fields: [
        { bytes: VKH_MFR },
        { bytes: VKH_MFR },
        { bytes: '05' },
        { int: 0 },
      ],
    });

    const [event, payload] = fakeTxSrv.send.mock.calls[0];
    expect(event).toBe('BuildPlutusSpendTransaction');
    expect(payload.scriptTxHash).toBe(SCRIPT_TX);
    expect(payload.scriptOutputIndex).toBe(0);
    expect(payload.lockOnScript).toBe(true);

    // spend redeemer constr 2 with INPUT_IDX placeholder for counter
    const spendR = JSON.parse(payload.redeemerJson);
    expect(spendR.constructor).toBe(2);
    expect(spendR.fields[0].int).toBe(`__INPUT_IDX:${SCRIPT_TX}#0__`);

    // mint redeemer constr 1 with same INPUT_IDX placeholder
    const mintR = JSON.parse(payload.mintRedeemerJson);
    expect(mintR.constructor).toBe(1);
    expect(mintR.fields[0].int).toBe(`__INPUT_IDX:${SCRIPT_TX}#0__`);

    // mintActions uses fully-qualified assetUnit (policyId + assetName)
    expect(JSON.parse(payload.mintActionsJson)).toEqual([
      { assetUnit: POLICY + '05', quantity: '1' },
    ]);

    // extraOutputs has the batch NFT with ChainOfCustody inline datum
    const extras = JSON.parse(payload.extraOutputsJson);
    expect(extras).toHaveLength(1);
    expect(extras[0].address).toBe(SCRIPT_ADDR);
    expect(extras[0].assets).toEqual([{ unit: POLICY + '05', quantity: '1' }]);

    // requiredSigners = manufacturer
    expect(JSON.parse(payload.requiredSignersJson)).toEqual([VKH_MFR]);

    // new counter datum at primary output has currentN+1
    expect(JSON.parse(payload.inlineDatumJson)).toEqual({
      constructor: 1,
      fields: [{ bytes: VKH_MFR }, { int: 5 }],
    });
  });

  it('uses fingerprint=empty when ODATANO does not return one', async () => {
    fakeTxSrv.send.mockResolvedValue({
      id: 'x', unsignedTxCbor: '', txBodyHash: '',
      // no fingerprint
    });
    const result = await chainAdapter.mintBatchNft({
      senderAddress: ADDR, manufacturerVkh: VKH_MFR, batchId: 'B-2', originDigest: '',
      counter: {
        policyId: POLICY, scriptAddress: SCRIPT_ADDR,
        seedTxHash: SEED_TX, seedIdx: 0,
        currentN: 0, counterTxHash: SCRIPT_TX, counterIdx: 0,
      },
    });
    expect(result.fingerprint).toBe('');
    // first batch: n+1 = 1 → '01'
    expect(result.assetName).toBe('01');
  });
});

describe('mintRegistrationNft', () => {
  it('builds a BuildMintTransaction with asset "REGISTRATION", to senderAddress', async () => {
    fakeTxSrv.send.mockResolvedValue({
      id: 'b-reg', unsignedTxCbor: 'c', txBodyHash: 'h', scriptHash: POLICY,
    });

    const result = await chainAdapter.mintRegistrationNft({
      senderAddress: ADDR,
      registrantVkh: VKH_MFR,
    });

    expect(result).toEqual({
      buildId: 'b-reg', unsignedCbor: 'c', txBodyHash: 'h', policyId: POLICY,
    });

    const [event, payload] = fakeTxSrv.send.mock.calls[0];
    expect(event).toBe('BuildMintTransaction');
    expect(payload.senderAddress).toBe(ADDR);
    expect(payload.recipientAddress).toBe(ADDR);
    // REGISTRATION in hex
    expect(JSON.parse(payload.mintActionsJson)).toEqual([
      { assetUnit: '524547495354524154494f4e', quantity: '1' },
    ]);
    expect(JSON.parse(payload.scriptParamsJson)).toEqual([{ bytes: VKH_MFR }]);
    expect(JSON.parse(payload.requiredSignersJson)).toEqual([VKH_MFR]);
    // No lockOnScript / no inlineDatumJson — NFT goes to wallet, not script
    expect(payload.lockOnScript).toBeUndefined();
    expect(payload.inlineDatumJson).toBeUndefined();
  });
});

describe('mintRegistrationNftFor', () => {
  it('sends to recipientAddress with senderVkh as required signer + script param', async () => {
    fakeTxSrv.send.mockResolvedValue({
      id: 'b-add', unsignedTxCbor: 'c', txBodyHash: 'h', scriptHash: POLICY,
    });

    const result = await chainAdapter.mintRegistrationNftFor({
      senderAddress: ADDR,
      senderVkh: VKH_MFR,
      recipientAddress: 'addr_test1qq' + 'r'.repeat(99),
    });

    expect(result.policyId).toBe(POLICY);
    const [, payload] = fakeTxSrv.send.mock.calls[0];
    expect(payload.senderAddress).toBe(ADDR);
    expect(payload.recipientAddress).toBe('addr_test1qq' + 'r'.repeat(99));
    expect(payload.changeAddress).toBe(ADDR);
    expect(JSON.parse(payload.scriptParamsJson)).toEqual([{ bytes: VKH_MFR }]);
    expect(JSON.parse(payload.requiredSignersJson)).toEqual([VKH_MFR]);
  });
});

describe('transferBatch', () => {
  it('builds a BuildPlutusSpendTransaction with Transfer redeemer + new ChainOfCustody datum, currentHolder as required signer', async () => {
    fakeTxSrv.send.mockResolvedValue({
      id: 'b-xfer', unsignedTxCbor: 'c', txBodyHash: 'h',
    });

    const result = await chainAdapter.transferBatch({
      senderAddress: ADDR,
      manufacturerVkh: VKH_MFR,
      currentHolderVkh: VKH_HOLD,
      nextHolderVkh: VKH_NEXT,
      batchIdHex: '01',
      currentStep: 1,
      scriptTxHash: SCRIPT_TX,
      scriptOutputIndex: 2,
      seedTxHash: SEED_TX,
      seedIdx: 0,
    });

    expect(result).toEqual({
      buildId: 'b-xfer', unsignedCbor: 'c', txBodyHash: 'h',
    });

    const [event, payload] = fakeTxSrv.send.mock.calls[0];
    expect(event).toBe('BuildPlutusSpendTransaction');
    expect(payload.scriptTxHash).toBe(SCRIPT_TX);
    expect(payload.scriptOutputIndex).toBe(2);
    expect(payload.lockOnScript).toBe(true);

    // Transfer redeemer is constr 0 with INPUT_IDX placeholder
    const r = JSON.parse(payload.redeemerJson);
    expect(r.constructor).toBe(0);
    expect(r.fields[0].int).toBe(`__INPUT_IDX:${SCRIPT_TX}#2__`);
    expect(r.fields[1]).toEqual({ int: 0 });

    // Output datum increments step + advances holder
    const datum = JSON.parse(payload.inlineDatumJson);
    expect(datum).toEqual({
      constructor: 0,
      fields: [
        { bytes: VKH_MFR },
        { bytes: VKH_NEXT },
        { bytes: '01' },
        { int: 2 }, // currentStep + 1
      ],
    });

    expect(JSON.parse(payload.requiredSignersJson)).toEqual([VKH_HOLD]);

    // Buildooor "inline" mode requires NO datumJson (omits witness datum)
    expect(payload.datumJson).toBeUndefined();
  });
});

describe('deliverBatch', () => {
  it('builds a spend with Deliver redeemer (constr 1, empty fields) and NO lockOnScript', async () => {
    fakeTxSrv.send.mockResolvedValue({
      id: 'b-del', unsignedTxCbor: 'c', txBodyHash: 'h',
    });

    const result = await chainAdapter.deliverBatch({
      senderAddress: ADDR,
      manufacturerVkh: VKH_MFR,
      currentHolderVkh: VKH_HOLD,
      batchIdHex: '02',
      currentStep: 3,
      scriptTxHash: SCRIPT_TX,
      scriptOutputIndex: 1,
      seedTxHash: SEED_TX,
      seedIdx: 0,
    });

    expect(result).toEqual({ buildId: 'b-del', unsignedCbor: 'c', txBodyHash: 'h' });

    const [, payload] = fakeTxSrv.send.mock.calls[0];
    expect(payload.lockOnScript).toBeUndefined();
    expect(payload.inlineDatumJson).toBeUndefined();
    expect(JSON.parse(payload.redeemerJson)).toEqual({ constructor: 1, fields: [] });
    expect(JSON.parse(payload.requiredSignersJson)).toEqual([VKH_HOLD]);
  });
});

describe('anchorDocument', () => {
  it('builds a BuildTransactionWithMetadata using metadataJson as-is', async () => {
    fakeTxSrv.send.mockResolvedValue({
      id: 'b-anc', unsignedTxCbor: 'c', txBodyHash: 'h',
    });

    const meta = JSON.stringify({ 674: { msg: ['hello'] } });
    const result = await chainAdapter.anchorDocument({
      senderAddress: ADDR,
      documentHash: 'h'.repeat(64),
      metadataJson: meta,
    });

    expect(result).toEqual({ buildId: 'b-anc', unsignedCbor: 'c', txBodyHash: 'h' });
    const [event, payload] = fakeTxSrv.send.mock.calls[0];
    expect(event).toBe('BuildTransactionWithMetadata');
    expect(payload.metadataJson).toBe(meta);
    expect(payload.changeAddress).toBe(ADDR);
  });
});

// ---------------------------------------------------------------------------
// Sign / Submit wrappers
// ---------------------------------------------------------------------------

describe('createSigningRequest', () => {
  it('calls CardanoSignService.send("CreateSigningRequest", { buildId })', async () => {
    fakeSignSrv.send.mockResolvedValue({
      id: 'sigreq-1', unsignedTxCbor: 'cbor', txBodyHash: 'hash',
    });

    const result = await chainAdapter.createSigningRequest('build-1');
    expect(fakeSignSrv.send).toHaveBeenCalledWith('CreateSigningRequest', { buildId: 'build-1' });
    expect(result).toEqual({
      signingRequestId: 'sigreq-1',
      unsignedTxCbor: 'cbor',
      txBodyHash: 'hash',
    });
  });
});

describe('submitSigned', () => {
  it('happy path: returns shaped result', async () => {
    fakeSignSrv.send.mockResolvedValue({
      txHash: 'tx' + 'f'.repeat(62), id: 'sub-1', status: 'submitted',
    });

    const result = await chainAdapter.submitSigned('sigreq-1', 'wcbor');
    expect(fakeSignSrv.send).toHaveBeenCalledWith('SubmitVerifiedTransaction', {
      signingRequestId: 'sigreq-1',
      signedTxCbor: 'wcbor',
    });
    expect(result).toEqual({
      txHash: 'tx' + 'f'.repeat(62),
      submissionId: 'sub-1',
      status: 'submitted',
    });
  });

  it('recovers from "already been included" by reading the SigningRequest for txBodyHash', async () => {
    fakeSignSrv.send.mockImplementation(async (event: any) => {
      if (event === 'SubmitVerifiedTransaction') {
        throw new Error('Inputs already been included in a previous tx');
      }
      // READ for SigningRequests
      return { txBodyHash: 'recovered-body-hash' };
    });

    const result = await chainAdapter.submitSigned('sigreq-x', 'wcbor');
    expect(result.txHash).toBe('recovered-body-hash');
    expect(result.submissionId).toBe('sigreq-x');
    expect(result.status).toBe('submitted');
  });

  it('recovers from "All inputs are spent"', async () => {
    fakeSignSrv.send.mockImplementation(async (event: any) => {
      if (event === 'SubmitVerifiedTransaction') {
        throw new Error('All inputs are spent already');
      }
      return null; // READ returns nothing → fall back to signingRequestId
    });

    const result = await chainAdapter.submitSigned('sigreq-y', 'wcbor');
    expect(result.txHash).toBe('sigreq-y'); // fallback when READ returns null
    expect(result.status).toBe('submitted');
  });

  it('re-throws unrecognised errors', async () => {
    fakeSignSrv.send.mockRejectedValue(new Error('something completely else'));
    await expect(chainAdapter.submitSigned('sigreq-z', 'w'))
      .rejects.toThrow(/completely else/);
  });
});

describe('checkSubmissionStatus', () => {
  it('returns shaped status when ODATANO responds', async () => {
    fakeTxSrv.send.mockResolvedValue({
      status: 'confirmed', txHash: 'th', errorMessage: null,
    });
    const result = await chainAdapter.checkSubmissionStatus('sub-1');
    expect(result).toEqual({
      status: 'confirmed', txHash: 'th', errorMessage: null,
    });
    const [arg] = fakeTxSrv.send.mock.calls[0];
    // chain-adapter sends a typed envelope to CheckSubmissionStatus
    expect(arg.event).toBe('CheckSubmissionStatus');
    expect(arg.params).toEqual([{ id: 'sub-1' }]);
  });

  it('defaults missing fields ("submitted" status, null txHash/error)', async () => {
    fakeTxSrv.send.mockResolvedValue({});
    const result = await chainAdapter.checkSubmissionStatus('sub-x');
    expect(result.status).toBe('submitted');
    expect(result.txHash).toBeNull();
    expect(result.errorMessage).toBeNull();
  });

  it('returns "unknown" status on send error', async () => {
    fakeTxSrv.send.mockRejectedValue(new Error('connection refused'));
    const result = await chainAdapter.checkSubmissionStatus('sub-fail');
    expect(result.status).toBe('unknown');
    expect(result.errorMessage).toMatch(/connection refused/);
  });
});

// ---------------------------------------------------------------------------
// Read helpers (ODATANO queries)
// ---------------------------------------------------------------------------

describe('getScriptOutputIndex', () => {
  it('returns the index of the output whose address matches', async () => {
    fakeODataSrv.send.mockResolvedValue({
      outputs: [
        { address: 'addr_other', outputIndex: 0 },
        { address: SCRIPT_ADDR, outputIndex: 2 },
      ],
    });
    expect(await chainAdapter.getScriptOutputIndex('tx', SCRIPT_ADDR)).toBe(2);
  });

  it('returns 0 when the script address is not found in outputs', async () => {
    fakeODataSrv.send.mockResolvedValue({ outputs: [{ address: 'other' }] });
    expect(await chainAdapter.getScriptOutputIndex('tx', SCRIPT_ADDR)).toBe(0);
  });

  it('returns 0 when send throws (tx not yet indexed)', async () => {
    fakeODataSrv.send.mockRejectedValue(new Error('not found'));
    expect(await chainAdapter.getScriptOutputIndex('tx', SCRIPT_ADDR)).toBe(0);
  });
});

describe('getAssetOutputIndex', () => {
  it('matches an output by composed unit (policyId + assetName) via assets[]', async () => {
    fakeODataSrv.send.mockResolvedValue({
      outputs: [
        { outputIndex: 0, assets: [{ unit: 'lovelace', quantity: '2000000' }] },
        { outputIndex: 1, assets: [{ unit: POLICY + '05', quantity: '1' }] },
      ],
    });
    expect(await chainAdapter.getAssetOutputIndex('tx', POLICY, '05')).toBe(1);
  });

  it('matches when assets use policyId + assetName fields instead of unit', async () => {
    fakeODataSrv.send.mockResolvedValue({
      outputs: [
        { outputIndex: 7, assets: [{ policyId: POLICY, assetName: '05', quantity: '1' }] },
      ],
    });
    expect(await chainAdapter.getAssetOutputIndex('tx', POLICY, '05')).toBe(7);
  });

  it('falls back to the `amount` array when `assets` is missing', async () => {
    fakeODataSrv.send.mockResolvedValue({
      outputs: [
        { outputIndex: 3, amount: [{ unit: POLICY + '05', quantity: '1' }] },
      ],
    });
    expect(await chainAdapter.getAssetOutputIndex('tx', POLICY, '05')).toBe(3);
  });

  it('returns null when no output contains the asset', async () => {
    fakeODataSrv.send.mockResolvedValue({
      outputs: [{ outputIndex: 0, assets: [{ unit: 'lovelace' }] }],
    });
    expect(await chainAdapter.getAssetOutputIndex('tx', POLICY, '05')).toBeNull();
  });

  it('returns null when result has no outputs', async () => {
    fakeODataSrv.send.mockResolvedValue({});
    expect(await chainAdapter.getAssetOutputIndex('tx', POLICY, '05')).toBeNull();
  });

  it('returns null when send throws', async () => {
    fakeODataSrv.send.mockRejectedValue(new Error('boom'));
    expect(await chainAdapter.getAssetOutputIndex('tx', POLICY, '05')).toBeNull();
  });
});

describe('isTxConfirmedOnChain', () => {
  it('returns true when result has a blockHash', async () => {
    fakeODataSrv.send.mockResolvedValue({ blockHash: 'b'.repeat(64) });
    expect(await chainAdapter.isTxConfirmedOnChain('tx')).toBe(true);
  });

  it('returns false when result has no blockHash', async () => {
    fakeODataSrv.send.mockResolvedValue({ blockHash: null });
    expect(await chainAdapter.isTxConfirmedOnChain('tx')).toBe(false);
  });

  it('returns false on send error', async () => {
    fakeODataSrv.send.mockRejectedValue(new Error('down'));
    expect(await chainAdapter.isTxConfirmedOnChain('tx')).toBe(false);
  });
});

describe('getTxStatus', () => {
  it('returns confirmed shape when ODATANO returns a block', async () => {
    fakeODataSrv.send.mockResolvedValue({ blockHash: 'b'.repeat(64), slot: 12345 });
    const result = await chainAdapter.getTxStatus('tx');
    expect(result).toEqual({
      status: 'confirmed', block: 'b'.repeat(64), slot: 12345,
    });
  });

  it('returns pending on 404 from ODATANO', async () => {
    const err: any = new Error('not found'); err.code = 404;
    fakeODataSrv.send.mockRejectedValue(err);
    const result = await chainAdapter.getTxStatus('tx');
    expect(result).toEqual({ status: 'pending', block: null, slot: null });
  });

  it('also matches err.status === 404 (Buildooor / ODATANO variant)', async () => {
    const err: any = new Error('not found'); err.status = 404;
    fakeODataSrv.send.mockRejectedValue(err);
    const result = await chainAdapter.getTxStatus('tx');
    expect(result.status).toBe('pending');
  });

  it('re-throws non-404 errors', async () => {
    const err: any = new Error('500 oops'); err.code = 500;
    fakeODataSrv.send.mockRejectedValue(err);
    await expect(chainAdapter.getTxStatus('tx')).rejects.toThrow(/500 oops/);
  });
});

describe('getWalletAssets', () => {
  it('triggers GetAddressByBech32 indexing first, then returns GetAssetsByAddress result', async () => {
    fakeODataSrv.send
      .mockResolvedValueOnce({ address: ADDR })       // GetAddressByBech32
      .mockResolvedValueOnce([{ unit: POLICY + '01' }]); // GetAssetsByAddress

    const result = await chainAdapter.getWalletAssets(ADDR);
    expect(result).toEqual([{ unit: POLICY + '01' }]);

    expect(fakeODataSrv.send).toHaveBeenNthCalledWith(1, 'GetAddressByBech32', { address: ADDR });
    expect(fakeODataSrv.send).toHaveBeenNthCalledWith(2, 'GetAssetsByAddress', { address: ADDR });
  });
});

// ---------------------------------------------------------------------------
// pickSeedUtxo — dynamic import of @odatano/core
// ---------------------------------------------------------------------------

describe('pickSeedUtxo', () => {
  it('picks the first pure-ADA UTxO meeting the minLovelace threshold', async () => {
    (getCardanoClient as jest.Mock).mockReturnValue({
      getAddress: jest.fn().mockResolvedValue({
        utxos: [
          { txHash: 'mixed', outputIndex: 0,
            amount: [
              { unit: 'lovelace', quantity: '5000000' },
              { unit: POLICY + '01', quantity: '1' },
            ] },
          { txHash: 'pure', outputIndex: 1,
            amount: [{ unit: 'lovelace', quantity: '10000000' }] },
        ],
      }),
    });

    const result = await chainAdapter.pickSeedUtxo(ADDR);
    expect(result).toEqual({ txHash: 'pure', outputIndex: 1 });
  });

  it('falls back to the first UTxO when no pure-ADA UTxO matches minLovelace', async () => {
    (getCardanoClient as jest.Mock).mockReturnValue({
      getAddress: jest.fn().mockResolvedValue({
        utxos: [
          { txHash: 'tiny', outputIndex: 0,
            amount: [{ unit: 'lovelace', quantity: '500000' }] }, // < 3 ADA
          { txHash: 'has-tokens', outputIndex: 0,
            amount: [
              { unit: 'lovelace', quantity: '5000000' },
              { unit: POLICY + '01', quantity: '1' },
            ] },
        ],
      }),
    });

    const result = await chainAdapter.pickSeedUtxo(ADDR);
    expect(result).toEqual({ txHash: 'tiny', outputIndex: 0 });
  });

  it('accepts alternate field names (transactionHash / tx_hash / hash, tx_index / index)', async () => {
    (getCardanoClient as jest.Mock).mockReturnValue({
      getAddress: jest.fn().mockResolvedValue({
        utxos: [
          // Koios-style fields
          { tx_hash: 'koios-hash', tx_index: 4,
            amount: [{ unit: 'lovelace', quantity: '10000000' }] },
        ],
      }),
    });
    const result = await chainAdapter.pickSeedUtxo(ADDR);
    expect(result).toEqual({ txHash: 'koios-hash', outputIndex: 4 });
  });

  it('throws when the wallet has no UTxOs', async () => {
    (getCardanoClient as jest.Mock).mockReturnValue({
      getAddress: jest.fn().mockResolvedValue({ utxos: [] }),
    });
    await expect(chainAdapter.pickSeedUtxo(ADDR))
      .rejects.toThrow(/No UTxOs at addr_test/);
  });

  it('throws when the chosen UTxO has no txHash field at all', async () => {
    (getCardanoClient as jest.Mock).mockReturnValue({
      getAddress: jest.fn().mockResolvedValue({
        utxos: [{ outputIndex: 0, amount: [{ unit: 'lovelace', quantity: '10000000' }] }],
      }),
    });
    await expect(chainAdapter.pickSeedUtxo(ADDR))
      .rejects.toThrow(/no txHash field/);
  });
});
