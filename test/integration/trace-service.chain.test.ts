/**
 * Integration tests for the on-chain action handlers of TraceService.
 *
 * The `./lib/chain-adapter` module is jest.mock'd at the top — every export is
 * a `jest.fn()` whose return value tests configure per-case. This lets us
 * exercise every branch of every handler in trace-service.ts without booting
 * an ODATANO instance or talking to Cardano.
 *
 * Coverage target: every handler that calls into chainAdapter — InitManufacturerCounter,
 * MintBatchNft, TransferBatch, SubmitSigned, CheckPendingTransactions,
 * RetryFailedTransaction, AnchorDocument, RecallBatch, ConfirmReceipt,
 * RegisterParticipant, AddParticipant, and the on-chain branch of ResolveWallet.
 */

jest.mock('../../srv/lib/chain-adapter', () => ({
  pickSeedUtxo: jest.fn(),
  initCounter: jest.fn(),
  mintBatchNft: jest.fn(),
  mintRegistrationNft: jest.fn(),
  mintRegistrationNftFor: jest.fn(),
  transferBatch: jest.fn(),
  deliverBatch: jest.fn(),
  anchorDocument: jest.fn(),
  createSigningRequest: jest.fn(),
  submitSigned: jest.fn(),
  checkSubmissionStatus: jest.fn(),
  isTxConfirmedOnChain: jest.fn(),
  getAssetOutputIndex: jest.fn(),
  getScriptOutputIndex: jest.fn(),
  getWalletAssets: jest.fn(),
  getTxStatus: jest.fn(),
}));

import cds from '@sap/cds';
import * as chainAdapter from '../../srv/lib/chain-adapter';
const { INSERT, SELECT } = cds.ql;

const ca = chainAdapter as jest.Mocked<typeof chainAdapter>;

const VKH_MFR  = 'a'.repeat(56);
const VKH_DIST = 'b'.repeat(56);
const VKH_PHAR = 'c'.repeat(56);
const ADDR     = 'addr_test1qq' + 'm'.repeat(99);
const ADDR2    = 'addr_test1qq' + 'd'.repeat(99);
const POLICY   = 'p'.repeat(56);
const SEED_TX  = 's'.repeat(64);
const COUNTER_TX = 'k'.repeat(64);
const SCRIPT_ADDR = 'addr_test1zz' + 'x'.repeat(99);

function defaultSigningResp(buildId = 'build-1') {
  return {
    signingRequestId: 'sigreq-' + buildId,
    unsignedTxCbor: 'cbor-' + buildId,
    txBodyHash: 'hash-' + buildId,
  };
}

describe('TraceService — on-chain handlers (chain-adapter mocked)', () => {
  jest.setTimeout(60000);

  // `cdsTest` + `chai` instead of shadowing jest's globals `test` / `expect` —
  // we need jest's `expect` for `.toHaveBeenCalledWith(...)` on the mocks.
  const cdsTest = cds.test(__dirname + '/../../');
  const chai = cdsTest.expect;

  beforeEach(async () => {
    await cdsTest.data.reset();
    jest.clearAllMocks();
    ca.createSigningRequest.mockImplementation(async (buildId: string) =>
      defaultSigningResp(buildId)
    );
  });

  // ---------------------------------------------------------------------------
  // InitManufacturerCounter
  // ---------------------------------------------------------------------------
  describe('InitManufacturerCounter', () => {
    it('builds counter init, inserts PENDING ManufacturerCounter, returns CBOR', async () => {
      ca.pickSeedUtxo.mockResolvedValue({ txHash: SEED_TX, outputIndex: 2 });
      ca.initCounter.mockResolvedValue({
        buildId: 'b-init',
        unsignedCbor: 'cbor-init',
        txBodyHash: 'hash-init',
        policyId: POLICY,
        scriptAddress: SCRIPT_ADDR,
        seedTxHash: SEED_TX,
        seedIdx: 2,
      });

      const { status, data } = await cdsTest.post(
        '/odata/v4/trace/InitManufacturerCounter',
        { walletAddress: ADDR, walletVkh: VKH_MFR }
      );
      chai(status).to.equal(200);
      chai(data.policyId).to.equal(POLICY);
      chai(data.scriptAddress).to.equal(SCRIPT_ADDR);
      chai(data.seedTxHash).to.equal(SEED_TX);
      chai(data.seedIdx).to.equal(2);
      chai(data.signingRequestId).to.equal('sigreq-b-init');
      chai(data.unsignedCbor).to.equal('cbor-b-init');

      const { ManufacturerCounters } = cds.entities('trace');
      const row = await SELECT.one.from(ManufacturerCounters)
        .where({ manufacturerVkh: VKH_MFR });
      chai(row).to.exist;
      chai(row.status).to.equal('PENDING');
      chai(row.policyId).to.equal(POLICY);
      chai(row.currentN).to.equal(0);
      chai(row.buildId).to.equal('b-init');

      expect(ca.pickSeedUtxo).toHaveBeenCalledWith(ADDR);
      expect(ca.initCounter).toHaveBeenCalledWith(expect.objectContaining({
        senderAddress: ADDR,
        manufacturerVkh: VKH_MFR,
        seedTxHash: SEED_TX,
        seedIdx: 2,
      }));
    });

    it('rejects 400 when wallet address or vkh missing', async () => {
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/InitManufacturerCounter',
          { walletAddress: '', walletVkh: '' });
      } catch (err: any) {
        threw = true;
        chai(err.response.status).to.equal(400);
      }
      chai(threw).to.equal(true);
      expect(ca.pickSeedUtxo).not.toHaveBeenCalled();
    });

    it('rejects 409 when a SUBMITTED counter already exists for this manufacturer', async () => {
      const { ManufacturerCounters } = cds.entities('trace');
      await INSERT.into(ManufacturerCounters).entries({
        ID: cds.utils.uuid(),
        manufacturerVkh: VKH_MFR,
        policyId: POLICY,
        scriptAddress: SCRIPT_ADDR,
        seedTxHash: SEED_TX,
        seedIdx: 0,
        currentN: 0,
        status: 'SUBMITTED',
      });

      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/InitManufacturerCounter',
          { walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) {
        threw = true;
        chai(err.response.status).to.equal(409);
      }
      chai(threw).to.equal(true);
      expect(ca.initCounter).not.toHaveBeenCalled();
    });

    it('rejects 409 when CONFIRMED counter already exists', async () => {
      const { ManufacturerCounters } = cds.entities('trace');
      await INSERT.into(ManufacturerCounters).entries({
        ID: cds.utils.uuid(),
        manufacturerVkh: VKH_MFR,
        policyId: POLICY,
        scriptAddress: SCRIPT_ADDR,
        seedTxHash: SEED_TX,
        seedIdx: 0,
        currentN: 1,
        status: 'CONFIRMED',
      });

      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/InitManufacturerCounter',
          { walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) {
        threw = true;
        chai(err.response.status).to.equal(409);
      }
      chai(threw).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // MintBatchNft
  // ---------------------------------------------------------------------------
  describe('MintBatchNft', () => {
    const BATCH_ID = '10000000-0000-0000-0000-000000000001';

    async function seedBatch(extra: any = {}) {
      const { Batches } = cds.entities('trace');
      await INSERT.into(Batches).entries({
        ID: BATCH_ID,
        batchNumber: 'B-MINT',
        product: 'Vaccine-A',
        status: 'DRAFT',
        originPayload: '{"lot":"L1"}',
        ...extra,
      });
    }

    async function seedConfirmedCounter(extra: any = {}) {
      const { ManufacturerCounters } = cds.entities('trace');
      await INSERT.into(ManufacturerCounters).entries({
        ID: cds.utils.uuid(),
        manufacturerVkh: VKH_MFR,
        policyId: POLICY,
        scriptAddress: SCRIPT_ADDR,
        seedTxHash: SEED_TX,
        seedIdx: 0,
        currentN: 0,
        counterTxHash: COUNTER_TX,
        counterIdx: 0,
        status: 'CONFIRMED',
        ...extra,
      });
    }

    function mockMint() {
      ca.mintBatchNft.mockResolvedValue({
        buildId: 'b-mint',
        unsignedCbor: 'cbor-mint',
        txBodyHash: 'hash-mint',
        policyId: POLICY,
        assetName: '01',
        batchNumberOnChain: 1,
        fingerprint: 'asset1' + 'q'.repeat(38),
        scriptAddress: SCRIPT_ADDR,
        datum: 'd:01',
      });
    }

    it('happy path: creates OnChainAsset + PENDING MINT ProofEvent', async () => {
      await seedBatch();
      await seedConfirmedCounter();
      mockMint();

      const { status, data } = await cdsTest.post('/odata/v4/trace/MintBatchNft',
        { batchId: BATCH_ID, walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      chai(data.policyId).to.equal(POLICY);
      chai(data.assetName).to.equal('01');
      chai(data.fingerprint).to.equal('asset1' + 'q'.repeat(38));
      chai(data.signingRequestId).to.equal('sigreq-b-mint');

      const { OnChainAssets, ProofEvents } = cds.entities('trace');
      const asset = await SELECT.one.from(OnChainAssets).where({ batch_ID: BATCH_ID });
      chai(asset).to.exist;
      chai(asset.policyId).to.equal(POLICY);
      chai(asset.assetName).to.equal('01');
      chai(asset.manufacturerVkh).to.equal(VKH_MFR);
      chai(asset.currentHolder).to.equal(VKH_MFR);

      const evt = await SELECT.one.from(ProofEvents)
        .where({ batch_ID: BATCH_ID, eventType: 'MINT' });
      chai(evt).to.exist;
      chai(evt.status).to.equal('PENDING');
      chai(evt.signerVkh).to.equal(VKH_MFR);
      chai(evt.signingRequestId).to.equal('sigreq-b-mint');
    });

    it('happy path passes the loaded counter state into chainAdapter.mintBatchNft', async () => {
      await seedBatch();
      await seedConfirmedCounter({ currentN: 5, counterIdx: 1 });
      mockMint();

      await cdsTest.post('/odata/v4/trace/MintBatchNft',
        { batchId: BATCH_ID, walletAddress: ADDR, walletVkh: VKH_MFR });

      expect(ca.mintBatchNft).toHaveBeenCalledWith(expect.objectContaining({
        senderAddress: ADDR,
        manufacturerVkh: VKH_MFR,
        batchId: 'B-MINT',
        counter: expect.objectContaining({
          policyId: POLICY,
          currentN: 5,
          counterTxHash: COUNTER_TX,
          counterIdx: 1,
        }),
      }));
    });

    it('rejects 400 when wallet missing', async () => {
      await seedBatch();
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/MintBatchNft',
          { batchId: BATCH_ID, walletAddress: '', walletVkh: '' });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(400); }
      chai(threw).to.equal(true);
      expect(ca.mintBatchNft).not.toHaveBeenCalled();
    });

    it('rejects 404 when batch not found', async () => {
      await seedConfirmedCounter();
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/MintBatchNft',
          { batchId: '99999999-9999-9999-9999-999999999999',
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(404); }
      chai(threw).to.equal(true);
    });

    it('rejects 409 when counter not yet CONFIRMED', async () => {
      await seedBatch();
      // No counter at all
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/MintBatchNft',
          { batchId: BATCH_ID, walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });

    it('rejects 409 when CONFIRMED counter is missing counterTxHash (not yet advanced)', async () => {
      await seedBatch();
      const { ManufacturerCounters } = cds.entities('trace');
      await INSERT.into(ManufacturerCounters).entries({
        ID: cds.utils.uuid(),
        manufacturerVkh: VKH_MFR,
        policyId: POLICY,
        scriptAddress: SCRIPT_ADDR,
        seedTxHash: SEED_TX, seedIdx: 0,
        currentN: 0,
        status: 'CONFIRMED',
      });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/MintBatchNft',
          { batchId: BATCH_ID, walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });

    it('rejects 409 when batch already has a confirmed asset (currentUtxoRef set)', async () => {
      await seedBatch();
      await seedConfirmedCounter();
      const { OnChainAssets } = cds.entities('trace');
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(),
        batch_ID: BATCH_ID,
        policyId: POLICY,
        assetName: '01',
        currentUtxoRef: 't'.repeat(64) + '#0',
        step: 0,
      });

      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/MintBatchNft',
          { batchId: BATCH_ID, walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
      expect(ca.mintBatchNft).not.toHaveBeenCalled();
    });

    it('cleans up stale asset + supersedes pending MINT events on retry', async () => {
      await seedBatch();
      await seedConfirmedCounter();
      mockMint();

      const { OnChainAssets, ProofEvents } = cds.entities('trace');
      const oldAssetId = cds.utils.uuid();
      await INSERT.into(OnChainAssets).entries({
        ID: oldAssetId, batch_ID: BATCH_ID,
        policyId: 'old' + 'p'.repeat(53), assetName: '01', step: 0,
        // no currentUtxoRef → stale
      });
      const oldEvtId = cds.utils.uuid();
      await INSERT.into(ProofEvents).entries({
        ID: oldEvtId, batch_ID: BATCH_ID,
        eventType: 'MINT', payloadDigest: 'p'.repeat(64), status: 'PENDING',
      });

      const { status } = await cdsTest.post('/odata/v4/trace/MintBatchNft',
        { batchId: BATCH_ID, walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);

      const stale = await SELECT.one.from(OnChainAssets).where({ ID: oldAssetId });
      chai(stale).to.be.undefined;

      const supersededEvt = await SELECT.one.from(ProofEvents).where({ ID: oldEvtId });
      chai(supersededEvt.status).to.equal('FAILED');
      chai(supersededEvt.errorMessage).to.match(/Superseded/);

      const newAsset = await SELECT.one.from(OnChainAssets).where({ batch_ID: BATCH_ID });
      chai(newAsset).to.exist;
      chai(newAsset.policyId).to.equal(POLICY);
    });
  });

  // ---------------------------------------------------------------------------
  // TransferBatch
  // ---------------------------------------------------------------------------
  describe('TransferBatch', () => {
    const BATCH_ID = '20000000-0000-0000-0000-000000000001';
    const TARGET_ID = '20000000-aaaa-aaaa-aaaa-000000000001';

    async function seedReadyToTransfer(opts: { batchStatus?: string; assetUtxo?: string | null; assetHolder?: string } = {}) {
      const {
        batchStatus = 'MINTED',
        assetUtxo = 't'.repeat(64) + '#0',
        assetHolder = VKH_MFR,
      } = opts;
      const { Batches, OnChainAssets, ManufacturerCounters, Participants } = cds.entities('trace');

      await INSERT.into(Batches).entries({
        ID: BATCH_ID, batchNumber: 'B-XFER', product: 'Pill-X',
        status: batchStatus, originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(), batch_ID: BATCH_ID,
        policyId: POLICY, assetName: '01',
        currentUtxoRef: assetUtxo,
        step: 0,
        manufacturerVkh: VKH_MFR,
        currentHolder: assetHolder,
      });
      await INSERT.into(ManufacturerCounters).entries({
        ID: cds.utils.uuid(),
        manufacturerVkh: VKH_MFR, policyId: POLICY, scriptAddress: SCRIPT_ADDR,
        seedTxHash: SEED_TX, seedIdx: 0, currentN: 1,
        counterTxHash: COUNTER_TX, counterIdx: 0,
        status: 'CONFIRMED',
      });
      await INSERT.into(Participants).entries({
        ID: TARGET_ID, name: 'Distributor', role: 'Distributor',
        address: ADDR2, vkh: VKH_DIST, isActive: true,
      });
    }

    function mockTransfer() {
      ca.transferBatch.mockResolvedValue({
        buildId: 'b-xfer', unsignedCbor: 'cbor-xfer', txBodyHash: 'hash-xfer',
      });
    }

    it('happy path: builds tx, creates TRANSFER ProofEvent (holder update deferred)', async () => {
      await seedReadyToTransfer();
      mockTransfer();

      const { status, data } = await cdsTest.post('/odata/v4/trace/TransferBatch',
        { batchId: BATCH_ID, toParticipantId: TARGET_ID,
          transferReason: 'ROUTINE', transferNotes: 'handoff',
          walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      chai(data.signingRequestId).to.equal('sigreq-b-xfer');

      const { ProofEvents, Batches, OnChainAssets } = cds.entities('trace');
      const evt = await SELECT.one.from(ProofEvents)
        .where({ batch_ID: BATCH_ID, eventType: 'TRANSFER' });
      chai(evt).to.exist;
      chai(evt.status).to.equal('PENDING');
      chai(evt.targetParticipantId).to.equal(TARGET_ID);
      chai(evt.signerVkh).to.equal(VKH_MFR);

      // Holder update is deferred to SubmitSigned — batch stays MINTED for now
      const batch = await SELECT.one.from(Batches).where({ ID: BATCH_ID });
      chai(batch.status).to.equal('MINTED');
      const asset = await SELECT.one.from(OnChainAssets).where({ batch_ID: BATCH_ID });
      chai(asset.currentHolder).to.equal(VKH_MFR);

      expect(ca.transferBatch).toHaveBeenCalledWith(expect.objectContaining({
        currentHolderVkh: VKH_MFR,
        nextHolderVkh: VKH_DIST,
        scriptTxHash: 't'.repeat(64),
        scriptOutputIndex: 0,
        batchIdHex: '01',
        currentStep: 0,
        seedTxHash: SEED_TX,
      }));
    });

    it('also accepts IN_TRANSIT (multi-hop)', async () => {
      await seedReadyToTransfer({ batchStatus: 'IN_TRANSIT' });
      mockTransfer();
      const { status } = await cdsTest.post('/odata/v4/trace/TransferBatch',
        { batchId: BATCH_ID, toParticipantId: TARGET_ID,
          transferReason: '', transferNotes: '',
          walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
    });

    it('rejects 400 when wallet missing', async () => {
      await seedReadyToTransfer();
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/TransferBatch',
          { batchId: BATCH_ID, toParticipantId: TARGET_ID,
            transferReason: 'x', transferNotes: '',
            walletAddress: '', walletVkh: '' });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(400); }
      chai(threw).to.equal(true);
    });

    it('rejects 404 when batch missing', async () => {
      await seedReadyToTransfer();
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/TransferBatch',
          { batchId: '99999999-9999-9999-9999-999999999999', toParticipantId: TARGET_ID,
            transferReason: 'x', transferNotes: '',
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(404); }
      chai(threw).to.equal(true);
    });

    it('rejects 409 when batch status is DRAFT (not yet minted)', async () => {
      await seedReadyToTransfer({ batchStatus: 'DRAFT' });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/TransferBatch',
          { batchId: BATCH_ID, toParticipantId: TARGET_ID,
            transferReason: 'x', transferNotes: '',
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });

    it('rejects 409 when no currentUtxoRef (mint not yet confirmed)', async () => {
      await seedReadyToTransfer({ assetUtxo: null });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/TransferBatch',
          { batchId: BATCH_ID, toParticipantId: TARGET_ID,
            transferReason: 'x', transferNotes: '',
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });

    it('rejects 403 when caller is not the current holder', async () => {
      await seedReadyToTransfer({ assetHolder: VKH_PHAR });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/TransferBatch',
          { batchId: BATCH_ID, toParticipantId: TARGET_ID,
            transferReason: 'x', transferNotes: '',
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(403); }
      chai(threw).to.equal(true);
    });

    it('rejects 404 when target participant unknown', async () => {
      await seedReadyToTransfer();
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/TransferBatch',
          { batchId: BATCH_ID,
            toParticipantId: '99999999-9999-9999-9999-999999999999',
            transferReason: 'x', transferNotes: '',
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(404); }
      chai(threw).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SubmitSigned
  // ---------------------------------------------------------------------------
  describe('SubmitSigned', () => {
    function mockSubmit(extra: any = {}) {
      ca.submitSigned.mockResolvedValue({
        txHash: 'tx' + 'h'.repeat(62),
        submissionId: 'sub-1',
        status: 'submitted',
        ...extra,
      });
    }

    it('MINT event → SUBMITTED + batch becomes MINTED', async () => {
      const { Batches, ProofEvents } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const evtId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-SS-MINT', product: 'P', status: 'DRAFT', originPayload: '{}',
      });
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId,
        eventType: 'MINT', payloadDigest: 'd'.repeat(64),
        status: 'PENDING', signingRequestId: 'sigreq-mint-1',
      });
      mockSubmit();

      const { status, data } = await cdsTest.post('/odata/v4/trace/SubmitSigned',
        { signingRequestId: 'sigreq-mint-1', signedTxCbor: 'wcbor' });
      chai(status).to.equal(200);
      chai(data.status).to.equal('SUBMITTED');

      const evt = await SELECT.one.from(ProofEvents).where({ ID: evtId });
      chai(evt.status).to.equal('SUBMITTED');
      chai(evt.onChainTxHash).to.equal('tx' + 'h'.repeat(62));

      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      chai(batch.status).to.equal('MINTED');
    });

    it('TRANSFER event → IN_TRANSIT + updates holder from targetParticipantId', async () => {
      const { Batches, Participants, OnChainAssets, ProofEvents } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const targetId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-SS-XFER', product: 'P', status: 'MINTED', originPayload: '{}',
      });
      await INSERT.into(Participants).entries({
        ID: targetId, name: 'Next', role: 'Distributor',
        address: ADDR2, vkh: VKH_DIST, isActive: true,
      });
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(), batch_ID: batchId,
        policyId: POLICY, assetName: '01', step: 0,
        currentHolder: VKH_MFR,
      });
      await INSERT.into(ProofEvents).entries({
        ID: cds.utils.uuid(), batch_ID: batchId,
        eventType: 'TRANSFER', payloadDigest: 'd'.repeat(64),
        status: 'PENDING', signingRequestId: 'sigreq-xfer-1',
        targetParticipantId: targetId,
      });
      mockSubmit();

      await cdsTest.post('/odata/v4/trace/SubmitSigned',
        { signingRequestId: 'sigreq-xfer-1', signedTxCbor: 'w' });

      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      chai(batch.status).to.equal('IN_TRANSIT');
      chai(batch.currentHolder_ID).to.equal(targetId);

      const asset = await SELECT.one.from(OnChainAssets).where({ batch_ID: batchId });
      chai(asset.currentHolder).to.equal(VKH_DIST);
    });

    it('DELIVER event → DELIVERED', async () => {
      const { Batches, ProofEvents } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-SS-DEL', product: 'P', status: 'IN_TRANSIT', originPayload: '{}',
      });
      await INSERT.into(ProofEvents).entries({
        ID: cds.utils.uuid(), batch_ID: batchId,
        eventType: 'DELIVER', payloadDigest: 'd'.repeat(64),
        status: 'PENDING', signingRequestId: 'sigreq-del-1',
      });
      mockSubmit();

      await cdsTest.post('/odata/v4/trace/SubmitSigned',
        { signingRequestId: 'sigreq-del-1', signedTxCbor: 'w' });

      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      chai(batch.status).to.equal('DELIVERED');
    });

    it('ManufacturerCounter PENDING → SUBMITTED with submissionId', async () => {
      const { ManufacturerCounters } = cds.entities('trace');
      const ctrId = cds.utils.uuid();
      await INSERT.into(ManufacturerCounters).entries({
        ID: ctrId, manufacturerVkh: VKH_MFR, policyId: POLICY,
        scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 0, currentN: 0,
        status: 'PENDING', signingRequestId: 'sigreq-ctr-1',
      });
      mockSubmit({ submissionId: 'sub-ctr' });

      await cdsTest.post('/odata/v4/trace/SubmitSigned',
        { signingRequestId: 'sigreq-ctr-1', signedTxCbor: 'w' });

      const ctr = await SELECT.one.from(ManufacturerCounters).where({ ID: ctrId });
      chai(ctr.status).to.equal('SUBMITTED');
      chai(ctr.submissionId).to.equal('sub-ctr');
    });

    it('DocumentAnchor PENDING → SUBMITTED with txHash', async () => {
      const { Batches, DocumentAnchors } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const anchorId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-SS-DOC', product: 'P', status: 'DRAFT', originPayload: '{}',
      });
      await INSERT.into(DocumentAnchors).entries({
        ID: anchorId, batch_ID: batchId,
        documentHash: 'h'.repeat(64), documentType: 'COA', visibility: 'PUBLIC',
        status: 'PENDING', signingRequestId: 'sigreq-doc-1',
      });
      mockSubmit();

      await cdsTest.post('/odata/v4/trace/SubmitSigned',
        { signingRequestId: 'sigreq-doc-1', signedTxCbor: 'w' });

      const a = await SELECT.one.from(DocumentAnchors).where({ ID: anchorId });
      chai(a.status).to.equal('SUBMITTED');
      chai(a.onChainTxHash).to.equal('tx' + 'h'.repeat(62));
    });

    it('Participant registration PENDING → SUBMITTED', async () => {
      const { Participants } = cds.entities('trace');
      const pid = cds.utils.uuid();
      await INSERT.into(Participants).entries({
        ID: pid, name: 'Reg', role: 'Manufacturer', address: ADDR, vkh: VKH_MFR,
        registrationStatus: 'PENDING',
        registrationSigningRequestId: 'sigreq-reg-1',
      });
      mockSubmit();

      await cdsTest.post('/odata/v4/trace/SubmitSigned',
        { signingRequestId: 'sigreq-reg-1', signedTxCbor: 'w' });

      const p = await SELECT.one.from(Participants).where({ ID: pid });
      chai(p.registrationStatus).to.equal('SUBMITTED');
      chai(p.registrationTxHash).to.equal('tx' + 'h'.repeat(62));
    });
  });

  // ---------------------------------------------------------------------------
  // CheckPendingTransactions (action, not the background poller)
  // ---------------------------------------------------------------------------
  describe('CheckPendingTransactions', () => {
    it('confirms a SUBMITTED ProofEvent and advances batch + counter side-effects', async () => {
      const { Batches, OnChainAssets, ManufacturerCounters, ProofEvents, Participants } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const evtId = cds.utils.uuid();
      const txHash = 'a'.repeat(64);

      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-CHK', product: 'P', status: 'DRAFT', originPayload: '{}',
      });
      await INSERT.into(Participants).entries({
        ID: cds.utils.uuid(), name: 'Mfr', role: 'Manufacturer',
        address: ADDR, vkh: VKH_MFR, isActive: true,
      });
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(), batch_ID: batchId,
        policyId: POLICY, assetName: '01', step: 0,
        manufacturerVkh: VKH_MFR, currentHolder: VKH_MFR,
      });
      await INSERT.into(ManufacturerCounters).entries({
        ID: cds.utils.uuid(), manufacturerVkh: VKH_MFR, policyId: POLICY,
        scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 0,
        currentN: 0, counterTxHash: 'old' + 'k'.repeat(61), counterIdx: 0,
        status: 'CONFIRMED',
      });
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId,
        eventType: 'MINT', payloadDigest: 'd'.repeat(64),
        status: 'SUBMITTED', submissionId: 'sub-1',
        signerVkh: VKH_MFR,
      });

      ca.checkSubmissionStatus.mockResolvedValue({
        status: 'confirmed', txHash, errorMessage: null,
      });
      // First call (in _onConfirmed for batch NFT outputIdx), second call (counter outputIdx)
      ca.getAssetOutputIndex
        .mockResolvedValueOnce(1)   // batch NFT lookup
        .mockResolvedValueOnce(0);  // counter NFT lookup

      const { data } = await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});
      chai(data.confirmed).to.equal(1);
      chai(data.failed).to.equal(0);

      const evt = await SELECT.one.from(ProofEvents).where({ ID: evtId });
      chai(evt.status).to.equal('CONFIRMED');

      const asset = await SELECT.one.from(OnChainAssets).where({ batch_ID: batchId });
      chai(asset.currentUtxoRef).to.equal(txHash + '#1');

      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      chai(batch.status).to.equal('MINTED');

      const counter = await SELECT.one.from(ManufacturerCounters)
        .where({ manufacturerVkh: VKH_MFR });
      chai(counter.currentN).to.equal(1);
      chai(counter.counterTxHash).to.equal(txHash);
    });

    it('defers confirmation when batch-NFT not yet indexed (getAssetOutputIndex → null)', async () => {
      const { Batches, OnChainAssets, ProofEvents } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const evtId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-DEF', product: 'P', status: 'DRAFT', originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(), batch_ID: batchId,
        policyId: POLICY, assetName: '01', step: 0, manufacturerVkh: VKH_MFR,
      });
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId,
        eventType: 'MINT', payloadDigest: 'd'.repeat(64),
        status: 'SUBMITTED', submissionId: 'sub-defer',
      });
      ca.checkSubmissionStatus.mockResolvedValue({
        status: 'confirmed', txHash: 'a'.repeat(64), errorMessage: null,
      });
      ca.getAssetOutputIndex.mockResolvedValue(null);

      const { data } = await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});
      chai(data.confirmed).to.equal(0);

      const evt = await SELECT.one.from(ProofEvents).where({ ID: evtId });
      // Still SUBMITTED because side-effect threw, but lastCheckedAt was updated
      chai(evt.status).to.equal('SUBMITTED');
      chai(evt.lastCheckedAt).to.exist;
    });

    it('marks ProofEvent as FAILED when ODATANO reports failure', async () => {
      const { Batches, ProofEvents } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const evtId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-FAIL', product: 'P', status: 'DRAFT', originPayload: '{}',
      });
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId,
        eventType: 'MINT', payloadDigest: 'd'.repeat(64),
        status: 'SUBMITTED', submissionId: 'sub-bad',
      });
      ca.checkSubmissionStatus.mockResolvedValue({
        status: 'failed', txHash: null, errorMessage: 'invalid script witness',
      });

      const { data } = await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});
      chai(data.failed).to.equal(1);

      const evt = await SELECT.one.from(ProofEvents).where({ ID: evtId });
      chai(evt.status).to.equal('FAILED');
      chai(evt.errorMessage).to.equal('invalid script witness');
    });

    it('confirms a SUBMITTED participant registration', async () => {
      const { Participants } = cds.entities('trace');
      const pid = cds.utils.uuid();
      await INSERT.into(Participants).entries({
        ID: pid, name: 'R', role: 'Manufacturer', address: ADDR, vkh: VKH_MFR,
        registrationStatus: 'SUBMITTED', registrationSubmissionId: 'sub-r1',
      });
      ca.checkSubmissionStatus.mockResolvedValue({
        status: 'confirmed', txHash: 'b'.repeat(64), errorMessage: null,
      });

      const { data } = await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});
      chai(data.confirmed).to.equal(1);
      const p = await SELECT.one.from(Participants).where({ ID: pid });
      chai(p.registrationStatus).to.equal('CONFIRMED');
      chai(p.registrationTxHash).to.equal('b'.repeat(64));
    });

    it('confirms a SUBMITTED ManufacturerCounter and stores counterIdx', async () => {
      const { ManufacturerCounters } = cds.entities('trace');
      const ctrId = cds.utils.uuid();
      await INSERT.into(ManufacturerCounters).entries({
        ID: ctrId, manufacturerVkh: VKH_MFR, policyId: POLICY,
        scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 0,
        currentN: 0, status: 'SUBMITTED', submissionId: 'sub-ctr',
      });
      ca.checkSubmissionStatus.mockResolvedValue({
        status: 'confirmed', txHash: COUNTER_TX, errorMessage: null,
      });
      ca.getAssetOutputIndex.mockResolvedValue(0);

      const { data } = await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});
      chai(data.confirmed).to.equal(1);
      const ctr = await SELECT.one.from(ManufacturerCounters).where({ ID: ctrId });
      chai(ctr.status).to.equal('CONFIRMED');
      chai(ctr.counterTxHash).to.equal(COUNTER_TX);
      chai(ctr.counterIdx).to.equal(0);
    });
  });

  // ---------------------------------------------------------------------------
  // RetryFailedTransaction
  // ---------------------------------------------------------------------------
  describe('RetryFailedTransaction', () => {
    it('rebuilds a FAILED MINT event and resets it to PENDING', async () => {
      const { Batches, ProofEvents, ManufacturerCounters } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const evtId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-RETRY-MINT', product: 'P', status: 'DRAFT', originPayload: '{}',
      });
      await INSERT.into(ManufacturerCounters).entries({
        ID: cds.utils.uuid(), manufacturerVkh: VKH_MFR, policyId: POLICY,
        scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 0, currentN: 0,
        counterTxHash: COUNTER_TX, counterIdx: 0, status: 'CONFIRMED',
      });
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId,
        eventType: 'MINT', payloadDigest: 'd'.repeat(64),
        status: 'FAILED', errorMessage: 'old fail',
      });
      ca.mintBatchNft.mockResolvedValue({
        buildId: 'b-retry', unsignedCbor: 'c', txBodyHash: 'h',
        policyId: POLICY, assetName: '01', batchNumberOnChain: 1,
        fingerprint: 'asset1' + 'r'.repeat(38), scriptAddress: SCRIPT_ADDR, datum: '',
      });

      const { status, data } = await cdsTest.post('/odata/v4/trace/RetryFailedTransaction',
        { proofEventId: evtId, walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      chai(data.buildId).to.equal('b-retry');

      const evt = await SELECT.one.from(ProofEvents).where({ ID: evtId });
      chai(evt.status).to.equal('PENDING');
      chai(evt.errorMessage).to.equal(null);
      chai(evt.buildId).to.equal('b-retry');
    });

    it('rebuilds a FAILED TRANSFER event using the asset.currentUtxoRef + target', async () => {
      const { Batches, OnChainAssets, ProofEvents, ManufacturerCounters, Participants } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const evtId = cds.utils.uuid();
      const targetId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-RETRY-XFER', product: 'P', status: 'MINTED', originPayload: '{}',
      });
      await INSERT.into(Participants).entries({
        ID: targetId, name: 'T', role: 'Distributor', address: ADDR2, vkh: VKH_DIST,
      });
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(), batch_ID: batchId,
        policyId: POLICY, assetName: '02',
        currentUtxoRef: 'u'.repeat(64) + '#3',
        step: 1, manufacturerVkh: VKH_MFR, currentHolder: VKH_MFR,
      });
      await INSERT.into(ManufacturerCounters).entries({
        ID: cds.utils.uuid(), manufacturerVkh: VKH_MFR, policyId: POLICY,
        scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 0, currentN: 1,
        counterTxHash: COUNTER_TX, counterIdx: 0, status: 'CONFIRMED',
      });
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId,
        eventType: 'TRANSFER', payloadDigest: 'd'.repeat(64),
        status: 'FAILED', targetParticipantId: targetId,
      });
      ca.transferBatch.mockResolvedValue({
        buildId: 'b-xfer-retry', unsignedCbor: 'c', txBodyHash: 'h',
      });

      const { status } = await cdsTest.post('/odata/v4/trace/RetryFailedTransaction',
        { proofEventId: evtId, walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);

      expect(ca.transferBatch).toHaveBeenCalledWith(expect.objectContaining({
        currentHolderVkh: VKH_MFR, nextHolderVkh: VKH_DIST,
        scriptTxHash: 'u'.repeat(64), scriptOutputIndex: 3,
        batchIdHex: '02', currentStep: 1,
      }));
    });

    it('rebuilds a FAILED DELIVER event', async () => {
      const { Batches, OnChainAssets, ProofEvents, ManufacturerCounters } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const evtId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-RETRY-DEL', product: 'P', status: 'IN_TRANSIT', originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(), batch_ID: batchId,
        policyId: POLICY, assetName: '02',
        currentUtxoRef: 'u'.repeat(64) + '#2',
        step: 2, manufacturerVkh: VKH_MFR, currentHolder: VKH_MFR,
      });
      await INSERT.into(ManufacturerCounters).entries({
        ID: cds.utils.uuid(), manufacturerVkh: VKH_MFR, policyId: POLICY,
        scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 0, currentN: 1,
        counterTxHash: COUNTER_TX, counterIdx: 0, status: 'CONFIRMED',
      });
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId,
        eventType: 'DELIVER', payloadDigest: 'd'.repeat(64), status: 'FAILED',
      });
      ca.deliverBatch.mockResolvedValue({
        buildId: 'b-del-retry', unsignedCbor: 'c', txBodyHash: 'h',
      });

      const { status } = await cdsTest.post('/odata/v4/trace/RetryFailedTransaction',
        { proofEventId: evtId, walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      expect(ca.deliverBatch).toHaveBeenCalled();
    });

    it('rejects 404 when ProofEvent missing', async () => {
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RetryFailedTransaction',
          { proofEventId: '99999999-9999-9999-9999-999999999999',
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(404); }
      chai(threw).to.equal(true);
    });

    it('rejects 409 when event is not FAILED', async () => {
      const { Batches, ProofEvents } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const evtId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-R-OK', product: 'P', status: 'DRAFT', originPayload: '{}',
      });
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId,
        eventType: 'MINT', payloadDigest: 'd'.repeat(64), status: 'PENDING',
      });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RetryFailedTransaction',
          { proofEventId: evtId, walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // AnchorDocument + RecallBatch
  // ---------------------------------------------------------------------------
  describe('AnchorDocument', () => {
    it('builds tx, inserts DocumentAnchor + DOCUMENT_ANCHOR ProofEvent', async () => {
      const { Batches, DocumentAnchors, ProofEvents } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-ANCHOR', product: 'P', status: 'DRAFT', originPayload: '{}',
      });
      ca.anchorDocument.mockResolvedValue({
        buildId: 'b-anchor', unsignedCbor: 'c', txBodyHash: 'h',
      });

      const docHash = 'h'.repeat(64);
      const { status, data } = await cdsTest.post('/odata/v4/trace/AnchorDocument',
        { batchId, documentHash: docHash, documentType: 'COA', visibility: '',
          walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      chai(data.buildId).to.equal('b-anchor');

      const anchor = await SELECT.one.from(DocumentAnchors).where({ batch_ID: batchId });
      chai(anchor.status).to.equal('PENDING');
      chai(anchor.visibility).to.equal('PUBLIC'); // default applied when empty
      chai(anchor.documentType).to.equal('COA');

      const evt = await SELECT.one.from(ProofEvents)
        .where({ batch_ID: batchId, eventType: 'DOCUMENT_ANCHOR' });
      chai(evt).to.exist;
      chai(evt.status).to.equal('PENDING');
      chai(evt.payloadDigest).to.equal(docHash);
      chai(evt.schema).to.equal('COA');
    });

    it('rejects 404 when batch missing', async () => {
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/AnchorDocument',
          { batchId: '99999999-9999-9999-9999-999999999999',
            documentHash: 'h'.repeat(64), documentType: 'COA', visibility: 'PUBLIC',
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(404); }
      chai(threw).to.equal(true);
    });

    it('rejects 400 when wallet missing', async () => {
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/AnchorDocument',
          { batchId: cds.utils.uuid(),
            documentHash: 'h'.repeat(64), documentType: 'COA', visibility: 'PUBLIC',
            walletAddress: '', walletVkh: '' });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(400); }
      chai(threw).to.equal(true);
    });
  });

  describe('RecallBatch', () => {
    async function seedRecallable(status = 'MINTED') {
      const { Batches } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-RECALL', product: 'P',
        status, originPayload: '{}',
      });
      return batchId;
    }

    it('recalls a MINTED batch immediately + creates RECALL ProofEvent', async () => {
      const batchId = await seedRecallable('MINTED');
      ca.anchorDocument.mockResolvedValue({
        buildId: 'b-recall', unsignedCbor: 'c', txBodyHash: 'h',
      });

      const { status, data } = await cdsTest.post('/odata/v4/trace/RecallBatch',
        { batchId, reason: 'Contamination',
          walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      chai(data.buildId).to.equal('b-recall');

      const { Batches, ProofEvents } = cds.entities('trace');
      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      chai(batch.status).to.equal('RECALLED');

      const evt = await SELECT.one.from(ProofEvents)
        .where({ batch_ID: batchId, eventType: 'RECALL' });
      chai(evt).to.exist;
      chai(evt.schema).to.equal('TRACE_RECALL_V1');
      chai(evt.status).to.equal('PENDING');
    });

    it('rejects 409 on DRAFT batch', async () => {
      const batchId = await seedRecallable('DRAFT');
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RecallBatch',
          { batchId, reason: 'X', walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });

    it('rejects 409 on already-RECALLED batch', async () => {
      const batchId = await seedRecallable('RECALLED');
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RecallBatch',
          { batchId, reason: 'X', walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });

    it('rejects 400 when reason missing', async () => {
      const batchId = await seedRecallable('MINTED');
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RecallBatch',
          { batchId, reason: '', walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(400); }
      chai(threw).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ConfirmReceipt
  // ---------------------------------------------------------------------------
  describe('ConfirmReceipt', () => {
    async function seedInTransit(opts: { holder?: string; utxo?: string | null } = {}) {
      const { holder = VKH_PHAR, utxo = 'u'.repeat(64) + '#2' } = opts;
      const { Batches, OnChainAssets, ManufacturerCounters } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-RCPT', product: 'P', status: 'IN_TRANSIT', originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(), batch_ID: batchId,
        policyId: POLICY, assetName: '02', step: 2,
        currentUtxoRef: utxo,
        manufacturerVkh: VKH_MFR, currentHolder: holder,
      });
      await INSERT.into(ManufacturerCounters).entries({
        ID: cds.utils.uuid(), manufacturerVkh: VKH_MFR, policyId: POLICY,
        scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 0, currentN: 1,
        counterTxHash: COUNTER_TX, counterIdx: 0, status: 'CONFIRMED',
      });
      return batchId;
    }

    it('happy path: creates DELIVER ProofEvent (status stays IN_TRANSIT until SubmitSigned)', async () => {
      const batchId = await seedInTransit();
      ca.deliverBatch.mockResolvedValue({
        buildId: 'b-rcpt', unsignedCbor: 'c', txBodyHash: 'h',
      });

      const { status, data } = await cdsTest.post('/odata/v4/trace/ConfirmReceipt',
        { batchId, walletAddress: ADDR, walletVkh: VKH_PHAR });
      chai(status).to.equal(200);
      chai(data.buildId).to.equal('b-rcpt');

      const { ProofEvents } = cds.entities('trace');
      const evt = await SELECT.one.from(ProofEvents)
        .where({ batch_ID: batchId, eventType: 'DELIVER' });
      chai(evt).to.exist;
      chai(evt.status).to.equal('PENDING');
      chai(evt.schema).to.equal('TRACE_DELIVER_V1');
    });

    it('rejects 403 when caller is not the current holder', async () => {
      const batchId = await seedInTransit({ holder: VKH_DIST });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/ConfirmReceipt',
          { batchId, walletAddress: ADDR, walletVkh: VKH_PHAR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(403); }
      chai(threw).to.equal(true);
    });

    it('rejects 409 when batch is not IN_TRANSIT', async () => {
      const { Batches } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-NOPE', product: 'P', status: 'DRAFT', originPayload: '{}',
      });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/ConfirmReceipt',
          { batchId, walletAddress: ADDR, walletVkh: VKH_PHAR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });

    it('rejects 409 when asset has no currentUtxoRef', async () => {
      const batchId = await seedInTransit({ utxo: null });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/ConfirmReceipt',
          { batchId, walletAddress: ADDR, walletVkh: VKH_PHAR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // RegisterParticipant + AddParticipant + ResolveWallet (on-chain branch)
  // ---------------------------------------------------------------------------
  describe('RegisterParticipant', () => {
    function mockRegMint() {
      ca.mintRegistrationNft.mockResolvedValue({
        buildId: 'b-reg', unsignedCbor: 'c', txBodyHash: 'h', policyId: POLICY,
      });
    }

    it('creates a new participant with PENDING registration', async () => {
      mockRegMint();
      const { status, data } = await cdsTest.post('/odata/v4/trace/RegisterParticipant',
        { name: 'Acme', role: 'Manufacturer',
          walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      chai(data.policyId).to.equal(POLICY);

      const { Participants } = cds.entities('trace');
      const p = await SELECT.one.from(Participants).where({ vkh: VKH_MFR });
      chai(p).to.exist;
      chai(p.name).to.equal('Acme');
      chai(p.registrationStatus).to.equal('PENDING');
      chai(p.registrationPolicyId).to.equal(POLICY);
    });

    it('rebuilds when an existing participant is PENDING (re-register)', async () => {
      mockRegMint();
      const { Participants } = cds.entities('trace');
      const pid = cds.utils.uuid();
      await INSERT.into(Participants).entries({
        ID: pid, name: 'Old', role: 'Manufacturer',
        address: ADDR, vkh: VKH_MFR, registrationStatus: 'PENDING',
      });
      const { status, data } = await cdsTest.post('/odata/v4/trace/RegisterParticipant',
        { name: 'NewName', role: 'Distributor',
          walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      chai(data.participantId).to.equal(pid);

      const p = await SELECT.one.from(Participants).where({ ID: pid });
      chai(p.name).to.equal('NewName');
      chai(p.role).to.equal('Distributor');
      chai(p.registrationStatus).to.equal('PENDING');
    });

    it('rejects 409 when a CONFIRMED participant already exists', async () => {
      const { Participants } = cds.entities('trace');
      await INSERT.into(Participants).entries({
        ID: cds.utils.uuid(), name: 'X', role: 'Manufacturer',
        address: ADDR, vkh: VKH_MFR, registrationStatus: 'CONFIRMED',
      });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RegisterParticipant',
          { name: 'Y', role: 'Manufacturer',
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
      expect(ca.mintRegistrationNft).not.toHaveBeenCalled();
    });

    it('rejects 400 when name or role missing', async () => {
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RegisterParticipant',
          { name: '', role: '', walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(400); }
      chai(threw).to.equal(true);
    });
  });

  describe('AddParticipant', () => {
    function mockForMint() {
      ca.mintRegistrationNftFor.mockResolvedValue({
        buildId: 'b-add', unsignedCbor: 'c', txBodyHash: 'h', policyId: POLICY,
      });
    }

    it('creates a new participant on behalf of someone else', async () => {
      mockForMint();
      const { status, data } = await cdsTest.post('/odata/v4/trace/AddParticipant',
        { name: 'Hospital', role: 'Pharmacy',
          participantAddress: ADDR2, participantVkh: VKH_PHAR,
          walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      chai(data.policyId).to.equal(POLICY);

      const { Participants } = cds.entities('trace');
      const p = await SELECT.one.from(Participants).where({ vkh: VKH_PHAR });
      chai(p).to.exist;
      chai(p.address).to.equal(ADDR2);
      chai(p.registrationStatus).to.equal('PENDING');

      expect(ca.mintRegistrationNftFor).toHaveBeenCalledWith(expect.objectContaining({
        senderAddress: ADDR, senderVkh: VKH_MFR, recipientAddress: ADDR2,
      }));
    });

    it('rejects 409 when target VKH is already CONFIRMED', async () => {
      const { Participants } = cds.entities('trace');
      await INSERT.into(Participants).entries({
        ID: cds.utils.uuid(), name: 'X', role: 'Pharmacy',
        address: ADDR2, vkh: VKH_PHAR, registrationStatus: 'CONFIRMED',
      });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/AddParticipant',
          { name: 'Y', role: 'Pharmacy',
            participantAddress: ADDR2, participantVkh: VKH_PHAR,
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });

    it('rejects 400 when participantAddress or participantVkh missing', async () => {
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/AddParticipant',
          { name: 'X', role: 'Pharmacy',
            participantAddress: '', participantVkh: '',
            walletAddress: ADDR, walletVkh: VKH_MFR });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(400); }
      chai(threw).to.equal(true);
    });
  });

  describe('ResolveWallet (on-chain branch)', () => {
    const REGISTRATION_HEX = '524547495354524154494f4e';

    it('auto-creates participant when wallet has REGISTRATION NFT (via unit endsWith)', async () => {
      ca.getWalletAssets.mockResolvedValue([
        { unit: POLICY + REGISTRATION_HEX, asset_policyId: POLICY },
      ]);

      const { status, data } = await cdsTest.post('/odata/v4/trace/ResolveWallet',
        { walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      chai(data.source).to.equal('on-chain');
      chai(data.participantName).to.equal('Wallet holder');

      const { Participants } = cds.entities('trace');
      const p = await SELECT.one.from(Participants).where({ vkh: VKH_MFR });
      chai(p).to.exist;
      chai(p.registrationStatus).to.equal('CONFIRMED');
      chai(p.registrationPolicyId).to.equal(POLICY);
    });

    it('returns source=none when wallet has no REGISTRATION NFT', async () => {
      ca.getWalletAssets.mockResolvedValue([
        { unit: POLICY + 'aabbcc', asset_policyId: POLICY },
      ]);
      const { status, data } = await cdsTest.post('/odata/v4/trace/ResolveWallet',
        { walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(status).to.equal(200);
      chai(data.source).to.equal('none');
      chai(data.participantId).to.equal(null);
    });

    it('falls back to source=none when getWalletAssets throws', async () => {
      ca.getWalletAssets.mockRejectedValue(new Error('backend down'));
      const { data } = await cdsTest.post('/odata/v4/trace/ResolveWallet',
        { walletAddress: ADDR, walletVkh: VKH_MFR });
      chai(data.source).to.equal('none');
    });
  });
});
