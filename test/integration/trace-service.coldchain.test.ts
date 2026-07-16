/**
 * Integration tests for the full cold-chain condition-monitoring flow of
 * TraceService: InitColdChainMonitor → (confirm) → RecordSensorReadings →
 * (confirm, advancing counts/root/breach) → CloseColdChainMonitor → (confirm).
 *
 * Only the *network* exports of ./lib/chain-adapter are jest.fn()'d; the pure
 * builders/hashers (toHex, sha256Hex via digest) stay real via requireActual,
 * so the test recomputes the same commit-root the handler produces.
 */

jest.mock('../../srv/lib/chain-adapter', () => ({
  // pure helper kept real (mirrors srv/lib/chain-adapter.toHex)
  toHex: (s: string) => Buffer.from(s, 'utf8').toString('hex'),
  pickSeedUtxo: jest.fn(),
  initMonitor: jest.fn(),
  recordReadings: jest.fn(),
  closeMonitor: jest.fn(),
  createSigningRequest: jest.fn(),
  submitSigned: jest.fn(),
  checkSubmissionStatus: jest.fn(),
  getAssetOutputIndex: jest.fn(),
  isTxConfirmedOnChain: jest.fn(),
}));

import cds from '@sap/cds';
import * as chainAdapter from '../../srv/lib/chain-adapter';
import { computeDigest, sha256Hex } from '../../srv/lib/digest';
const { INSERT, SELECT, UPDATE } = cds.ql;

const ca = chainAdapter as jest.Mocked<typeof chainAdapter>;

const VKH_ORACLE = 'a'.repeat(56);
const VKH_OTHER  = 'b'.repeat(56);
const ADDR       = 'addr_test1qq' + 'm'.repeat(99);
const POLICY     = 'p'.repeat(56);
const SEED_TX    = 's'.repeat(64);
const MON_TX     = 'k'.repeat(64);   // monitor thread UTxO tx
const SCRIPT_ADDR = 'addr_test1zz' + 'x'.repeat(99);

function defaultSigningResp(buildId = 'build-1') {
  return {
    signingRequestId: 'sigreq-' + buildId,
    unsignedTxCbor: 'cbor-' + buildId,
    txBodyHash: 'hash-' + buildId,
  };
}

describe('TraceService — cold-chain flow (chain-adapter mocked)', () => {
  jest.setTimeout(60000);

  const cdsTest = cds.test(__dirname + '/../../');
  const chai = cdsTest.expect;

  beforeEach(async () => {
    await cdsTest.data.reset();
    jest.clearAllMocks();
    ca.createSigningRequest.mockImplementation(async (buildId: string) =>
      defaultSigningResp(buildId)
    );
  });

  // Seed a batch and return its id.
  async function seedBatch(extra: any = {}) {
    const { Batches } = cds.entities('trace');
    const batchId = cds.utils.uuid();
    await INSERT.into(Batches).entries({
      ID: batchId, batchNumber: 'B-CC', product: 'Vaccine-A',
      status: 'MINTED', originPayload: '{}', ...extra,
    });
    return batchId;
  }

  // Seed a CONFIRMED monitor with a live thread UTxO.
  async function seedConfirmedMonitor(extra: any = {}) {
    const batchId = await seedBatch();
    const { ConditionMonitors } = cds.entities('trace');
    const monitorId = cds.utils.uuid();
    await INSERT.into(ConditionMonitors).entries({
      ID: monitorId, batch_ID: batchId, oracleVkh: VKH_ORACLE,
      batchIdHex: '01', policyId: POLICY, scriptAddress: SCRIPT_ADDR,
      seedTxHash: SEED_TX, seedIdx: 0,
      minMilliC: 2000, maxMilliC: 8000,
      readingCount: 0, breachCount: 0,
      commitRoot: sha256Hex('genesis'), breached: false,
      currentUtxoRef: `${MON_TX}#0`, status: 'CONFIRMED',
      ...extra,
    });
    return { monitorId, batchId };
  }

  function mockInit() {
    ca.pickSeedUtxo.mockResolvedValue({ txHash: SEED_TX, outputIndex: 1 });
    ca.initMonitor.mockResolvedValue({
      buildId: 'b-init', unsignedCbor: 'cbor-init', txBodyHash: 'hash-init',
      policyId: POLICY, scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 1,
    });
  }

  // ---------------------------------------------------------------------------
  // InitColdChainMonitor
  // ---------------------------------------------------------------------------
  describe('InitColdChainMonitor', () => {
    it('happy path: mints monitor, inserts PENDING ConditionMonitor with genesis root', async () => {
      const batchId = await seedBatch();
      mockInit();

      const { status, data } = await cdsTest.post('/odata/v4/trace/InitColdChainMonitor',
        { batchId, minMilliC: 2000, maxMilliC: 8000, walletAddress: ADDR, walletVkh: VKH_ORACLE });
      chai(status).to.equal(200);
      chai(data.policyId).to.equal(POLICY);
      chai(data.scriptAddress).to.equal(SCRIPT_ADDR);
      chai(data.signingRequestId).to.equal('sigreq-b-init');

      const { ConditionMonitors } = cds.entities('trace');
      const row = await SELECT.one.from(ConditionMonitors).where({ ID: data.monitorId });
      chai(row).to.exist;
      chai(row.status).to.equal('PENDING');
      chai(row.oracleVkh).to.equal(VKH_ORACLE);
      chai(row.minMilliC).to.equal(2000);
      chai(row.maxMilliC).to.equal(8000);
      chai(row.readingCount).to.equal(0);
      chai(row.breachCount).to.equal(0);
      chai(row.breached).to.equal(false);
      // batchIdHex falls back to hex(batchNumber) when no on-chain asset exists
      chai(row.batchIdHex).to.equal(chainAdapter.toHex('B-CC'));

      // commit root stored == genesis root passed to initMonitor
      const initArg = ca.initMonitor.mock.calls[0][0];
      chai(initArg.genesisRoot).to.match(/^[0-9a-f]{64}$/);
      chai(row.commitRoot).to.equal(initArg.genesisRoot);
      chai(initArg.oracleVkh).to.equal(VKH_ORACLE);
      chai(initArg.batchIdHex).to.equal(chainAdapter.toHex('B-CC'));
    });

    it('binds batchIdHex to the on-chain asset name when the batch is minted', async () => {
      const batchId = await seedBatch();
      const { OnChainAssets } = cds.entities('trace');
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(), batch_ID: batchId, policyId: POLICY,
        assetName: '0a', step: 0,
      });
      mockInit();

      const { data } = await cdsTest.post('/odata/v4/trace/InitColdChainMonitor',
        { batchId, minMilliC: 2000, maxMilliC: 8000, walletAddress: ADDR, walletVkh: VKH_ORACLE });

      const { ConditionMonitors } = cds.entities('trace');
      const row = await SELECT.one.from(ConditionMonitors).where({ ID: data.monitorId });
      chai(row.batchIdHex).to.equal('0a');
      chai(ca.initMonitor.mock.calls[0][0].batchIdHex).to.equal('0a');
    });

    it('rejects 400 when wallet missing', async () => {
      const batchId = await seedBatch();
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/InitColdChainMonitor',
          { batchId, minMilliC: 2000, maxMilliC: 8000, walletAddress: '', walletVkh: '' });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(400); }
      chai(threw).to.equal(true);
      expect(ca.initMonitor).not.toHaveBeenCalled();
    });

    it('rejects 400 when minMilliC > maxMilliC', async () => {
      const batchId = await seedBatch();
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/InitColdChainMonitor',
          { batchId, minMilliC: 8000, maxMilliC: 2000, walletAddress: ADDR, walletVkh: VKH_ORACLE });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(400); }
      chai(threw).to.equal(true);
      expect(ca.initMonitor).not.toHaveBeenCalled();
    });

    it('rejects 404 when batch not found', async () => {
      mockInit();
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/InitColdChainMonitor',
          { batchId: '99999999-9999-9999-9999-999999999999',
            minMilliC: 2000, maxMilliC: 8000, walletAddress: ADDR, walletVkh: VKH_ORACLE });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(404); }
      chai(threw).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // RecordSensorReadings
  // ---------------------------------------------------------------------------
  describe('RecordSensorReadings', () => {
    function mockRecord() {
      ca.recordReadings.mockResolvedValue({
        buildId: 'b-rec', unsignedCbor: 'cbor-rec', txBodyHash: 'hash-rec',
      });
    }

    const READINGS_OK = [
      { metric: 'TEMPERATURE', milliValue: 4000, recordedAt: '2026-01-01T00:00:00.000Z' },
      { metric: 'TEMPERATURE', milliValue: 6000, recordedAt: '2026-01-01T01:00:00.000Z' },
    ];

    it('happy path (in-spec): inserts readings, SENSOR_ATTESTATION event, advances counts off-chain', async () => {
      const { monitorId, batchId } = await seedConfirmedMonitor();
      mockRecord();

      const { status, data } = await cdsTest.post('/odata/v4/trace/RecordSensorReadings',
        { monitorId, readingsJson: JSON.stringify(READINGS_OK), walletAddress: ADDR, walletVkh: VKH_ORACLE });
      chai(status).to.equal(200);
      chai(data.newReadingCount).to.equal(2);
      chai(data.newBreachCount).to.equal(0);
      chai(data.breached).to.equal(false);
      chai(data.signingRequestId).to.equal('sigreq-b-rec');

      // Readings persisted, uncommitted, all within spec
      const { ConditionReadings, ProofEvents } = cds.entities('trace');
      const readings = await SELECT.from(ConditionReadings).where({ monitor_ID: monitorId });
      chai(readings.length).to.equal(2);
      chai(readings.every((r: any) => r.withinSpec === true)).to.equal(true);
      chai(readings.every((r: any) => r.committedTxHash == null)).to.equal(true);

      // ProofEvent tracks the tx
      const evt = await SELECT.one.from(ProofEvents)
        .where({ monitorId, eventType: 'SENSOR_ATTESTATION' });
      chai(evt).to.exist;
      chai(evt.status).to.equal('PENDING');
      chai(evt.batch_ID).to.equal(batchId);

      // commit root passed to chain-adapter == sha256(prevRoot || leafHashes)
      const prevRoot = sha256Hex('genesis');
      const leaves = READINGS_OK.map(r => computeDigest({ metric: r.metric, milliValue: r.milliValue, recordedAt: r.recordedAt }));
      const expectedRoot = sha256Hex(prevRoot + leaves.join(''));
      const recArg = ca.recordReadings.mock.calls[0][0];
      chai(recArg.newCommitRoot).to.equal(expectedRoot);
      chai(recArg.newReadingCount).to.equal(2);
      chai(recArg.newBreached).to.equal(false);
      chai(recArg.scriptTxHash).to.equal(MON_TX);
      chai(recArg.scriptOutputIndex).to.equal(0);
      chai(evt.payloadDigest).to.equal(expectedRoot);
    });

    it('breach path: out-of-spec reading sets breachCount + latches breached', async () => {
      const { monitorId } = await seedConfirmedMonitor();
      mockRecord();
      const readings = [
        { metric: 'TEMPERATURE', milliValue: 5000, recordedAt: '2026-01-01T00:00:00.000Z' },
        { metric: 'TEMPERATURE', milliValue: 12000, recordedAt: '2026-01-01T02:00:00.000Z' }, // > 8000 → breach
      ];

      const { data } = await cdsTest.post('/odata/v4/trace/RecordSensorReadings',
        { monitorId, readingsJson: JSON.stringify(readings), walletAddress: ADDR, walletVkh: VKH_ORACLE });
      chai(data.newBreachCount).to.equal(1);
      chai(data.breached).to.equal(true);

      const { ConditionReadings } = cds.entities('trace');
      const breachRow = await SELECT.one.from(ConditionReadings)
        .where({ monitor_ID: monitorId, milliValue: 12000 });
      chai(breachRow.withinSpec).to.equal(false);

      chai(ca.recordReadings.mock.calls[0][0].newBreached).to.equal(true);
    });

    it('rejects 409 when monitor not CONFIRMED', async () => {
      const { monitorId } = await seedConfirmedMonitor({ status: 'PENDING', currentUtxoRef: null });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RecordSensorReadings',
          { monitorId, readingsJson: JSON.stringify(READINGS_OK), walletAddress: ADDR, walletVkh: VKH_ORACLE });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
      expect(ca.recordReadings).not.toHaveBeenCalled();
    });

    it('rejects 403 when caller is not the monitor oracle', async () => {
      const { monitorId } = await seedConfirmedMonitor();
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RecordSensorReadings',
          { monitorId, readingsJson: JSON.stringify(READINGS_OK), walletAddress: ADDR, walletVkh: VKH_OTHER });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(403); }
      chai(threw).to.equal(true);
    });

    it('rejects 400 on empty readings array', async () => {
      const { monitorId } = await seedConfirmedMonitor();
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RecordSensorReadings',
          { monitorId, readingsJson: '[]', walletAddress: ADDR, walletVkh: VKH_ORACLE });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(400); }
      chai(threw).to.equal(true);
    });

    it('rejects 404 when monitor not found', async () => {
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RecordSensorReadings',
          { monitorId: '99999999-9999-9999-9999-999999999999',
            readingsJson: JSON.stringify(READINGS_OK), walletAddress: ADDR, walletVkh: VKH_ORACLE });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(404); }
      chai(threw).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // CloseColdChainMonitor
  // ---------------------------------------------------------------------------
  describe('CloseColdChainMonitor', () => {
    it('happy path: builds close tx + MONITOR_CLOSE ProofEvent', async () => {
      const { monitorId, batchId } = await seedConfirmedMonitor();
      ca.closeMonitor.mockResolvedValue({
        buildId: 'b-close', unsignedCbor: 'cbor-close', txBodyHash: 'hash-close',
      });

      const { status, data } = await cdsTest.post('/odata/v4/trace/CloseColdChainMonitor',
        { monitorId, walletAddress: ADDR, walletVkh: VKH_ORACLE });
      chai(status).to.equal(200);
      chai(data.buildId).to.equal('b-close');

      const { ProofEvents } = cds.entities('trace');
      const evt = await SELECT.one.from(ProofEvents)
        .where({ monitorId, eventType: 'MONITOR_CLOSE' });
      chai(evt).to.exist;
      chai(evt.status).to.equal('PENDING');
      chai(evt.batch_ID).to.equal(batchId);
      chai(ca.closeMonitor.mock.calls[0][0].scriptTxHash).to.equal(MON_TX);
    });

    it('rejects 409 when monitor not CONFIRMED', async () => {
      const { monitorId } = await seedConfirmedMonitor({ status: 'SUBMITTED', currentUtxoRef: null });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/CloseColdChainMonitor',
          { monitorId, walletAddress: ADDR, walletVkh: VKH_ORACLE });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SubmitSigned — monitor init
  // ---------------------------------------------------------------------------
  describe('SubmitSigned (monitor init)', () => {
    it('ConditionMonitor PENDING → SUBMITTED with submissionId', async () => {
      const batchId = await seedBatch();
      const { ConditionMonitors } = cds.entities('trace');
      const monitorId = cds.utils.uuid();
      await INSERT.into(ConditionMonitors).entries({
        ID: monitorId, batch_ID: batchId, oracleVkh: VKH_ORACLE, batchIdHex: '01',
        policyId: POLICY, scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 0,
        minMilliC: 2000, maxMilliC: 8000, readingCount: 0, breachCount: 0,
        commitRoot: sha256Hex('g'), breached: false,
        status: 'PENDING', signingRequestId: 'sigreq-mon-1',
      });
      ca.submitSigned.mockResolvedValue({
        txHash: 'tx' + 'h'.repeat(62), submissionId: 'sub-mon', status: 'submitted',
      });

      await cdsTest.post('/odata/v4/trace/SubmitSigned',
        { signingRequestId: 'sigreq-mon-1', signedTxCbor: 'w' });

      const row = await SELECT.one.from(ConditionMonitors).where({ ID: monitorId });
      chai(row.status).to.equal('SUBMITTED');
      chai(row.submissionId).to.equal('sub-mon');
    });
  });

  // ---------------------------------------------------------------------------
  // CheckPendingTransactions — confirmation side-effects
  // ---------------------------------------------------------------------------
  describe('CheckPendingTransactions (cold-chain confirmations)', () => {
    it('confirms a SUBMITTED monitor init → CONFIRMED with currentUtxoRef', async () => {
      const batchId = await seedBatch();
      const { ConditionMonitors } = cds.entities('trace');
      const monitorId = cds.utils.uuid();
      await INSERT.into(ConditionMonitors).entries({
        ID: monitorId, batch_ID: batchId, oracleVkh: VKH_ORACLE, batchIdHex: '01',
        policyId: POLICY, scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 0,
        minMilliC: 2000, maxMilliC: 8000, readingCount: 0, breachCount: 0,
        commitRoot: sha256Hex('g'), breached: false,
        status: 'SUBMITTED', submissionId: 'sub-mon',
      });
      ca.checkSubmissionStatus.mockResolvedValue({ status: 'confirmed', txHash: MON_TX, errorMessage: null });
      ca.getAssetOutputIndex.mockResolvedValue(0);

      const { data } = await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});
      chai(data.confirmed).to.equal(1);

      const row = await SELECT.one.from(ConditionMonitors).where({ ID: monitorId });
      chai(row.status).to.equal('CONFIRMED');
      chai(row.currentUtxoRef).to.equal(`${MON_TX}#0`);
    });

    it('confirms a SENSOR_ATTESTATION event → advances monitor counts/root/breach + commits readings', async () => {
      const { monitorId } = await seedConfirmedMonitor();
      const { ConditionReadings, ProofEvents } = cds.entities('trace');
      const newTx = 'e'.repeat(64);
      const newRoot = sha256Hex('newroot');

      // Two uncommitted readings — one of them a breach.
      await INSERT.into(ConditionReadings).entries([
        { ID: cds.utils.uuid(), monitor_ID: monitorId, metric: 'TEMPERATURE',
          milliValue: 5000, recordedAt: '2026-01-01T00:00:00.000Z', withinSpec: true, leafHash: 'l1' },
        { ID: cds.utils.uuid(), monitor_ID: monitorId, metric: 'TEMPERATURE',
          milliValue: 12000, recordedAt: '2026-01-01T01:00:00.000Z', withinSpec: false, leafHash: 'l2' },
      ]);
      const evtId = cds.utils.uuid();
      await INSERT.into(ProofEvents).entries({
        ID: evtId, eventType: 'SENSOR_ATTESTATION', payloadDigest: newRoot,
        monitorId, status: 'SUBMITTED', submissionId: 'sub-rec',
      });
      ca.checkSubmissionStatus.mockResolvedValue({ status: 'confirmed', txHash: newTx, errorMessage: null });
      ca.getAssetOutputIndex.mockResolvedValue(0);

      const { data } = await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});
      chai(data.confirmed).to.equal(1);

      const { ConditionMonitors } = cds.entities('trace');
      const mon = await SELECT.one.from(ConditionMonitors).where({ ID: monitorId });
      chai(mon.readingCount).to.equal(2);
      chai(mon.breachCount).to.equal(1);
      chai(mon.breached).to.equal(true);
      chai(mon.commitRoot).to.equal(newRoot);
      chai(mon.currentUtxoRef).to.equal(`${newTx}#0`);

      // readings now committed to the confirming tx
      const committed = await SELECT.from(ConditionReadings).where({ monitor_ID: monitorId });
      chai(committed.every((r: any) => r.committedTxHash === newTx)).to.equal(true);

      const evt = await SELECT.one.from(ProofEvents).where({ ID: evtId });
      chai(evt.status).to.equal('CONFIRMED');
    });

    it('defers SENSOR_ATTESTATION confirmation when monitor token not yet indexed', async () => {
      const { monitorId } = await seedConfirmedMonitor();
      const { ProofEvents, ConditionMonitors } = cds.entities('trace');
      const evtId = cds.utils.uuid();
      await INSERT.into(ProofEvents).entries({
        ID: evtId, eventType: 'SENSOR_ATTESTATION', payloadDigest: sha256Hex('r'),
        monitorId, status: 'SUBMITTED', submissionId: 'sub-defer',
      });
      ca.checkSubmissionStatus.mockResolvedValue({ status: 'confirmed', txHash: 'f'.repeat(64), errorMessage: null });
      ca.getAssetOutputIndex.mockResolvedValue(null); // indexer lag

      const { data } = await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});
      chai(data.confirmed).to.equal(0);

      const evt = await SELECT.one.from(ProofEvents).where({ ID: evtId });
      chai(evt.status).to.equal('SUBMITTED'); // deferred, not confirmed
      const mon = await SELECT.one.from(ConditionMonitors).where({ ID: monitorId });
      chai(mon.readingCount).to.equal(0); // unchanged
    });

    it('confirms a MONITOR_CLOSE event → monitor CLOSED, UTxO cleared', async () => {
      const { monitorId } = await seedConfirmedMonitor();
      const { ProofEvents, ConditionMonitors } = cds.entities('trace');
      const evtId = cds.utils.uuid();
      await INSERT.into(ProofEvents).entries({
        ID: evtId, eventType: 'MONITOR_CLOSE', payloadDigest: sha256Hex('c'),
        monitorId, status: 'SUBMITTED', submissionId: 'sub-close',
      });
      ca.checkSubmissionStatus.mockResolvedValue({ status: 'confirmed', txHash: 'd'.repeat(64), errorMessage: null });

      const { data } = await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});
      chai(data.confirmed).to.equal(1);

      const mon = await SELECT.one.from(ConditionMonitors).where({ ID: monitorId });
      chai(mon.status).to.equal('CLOSED');
      chai(mon.currentUtxoRef).to.equal(null);
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-quarantine on breach
  // ---------------------------------------------------------------------------
  describe('auto-quarantine on breach', () => {
    async function seedPendingSensorEvent(monitorId: string, withinSpec: boolean) {
      const { ConditionReadings, ProofEvents } = cds.entities('trace');
      await INSERT.into(ConditionReadings).entries({
        ID: cds.utils.uuid(), monitor_ID: monitorId, metric: 'TEMPERATURE',
        milliValue: withinSpec ? 5000 : 14000,
        recordedAt: '2026-01-01T00:00:00.000Z', withinSpec, leafHash: 'lf',
      });
      const evtId = cds.utils.uuid();
      await INSERT.into(ProofEvents).entries({
        ID: evtId, eventType: 'SENSOR_ATTESTATION', payloadDigest: sha256Hex('r'),
        monitorId, status: 'SUBMITTED', submissionId: 'sub-q',
      });
      ca.checkSubmissionStatus.mockResolvedValue({ status: 'confirmed', txHash: 'q'.repeat(64), errorMessage: null });
      ca.getAssetOutputIndex.mockResolvedValue(0);
      return evtId;
    }

    it('a breach confirmation quarantines the batch', async () => {
      const { monitorId, batchId } = await seedConfirmedMonitor(); // batch starts MINTED
      await seedPendingSensorEvent(monitorId, false);

      await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});

      const { Batches } = cds.entities('trace');
      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      chai(batch.status).to.equal('QUARANTINE');
    });

    it('an in-spec confirmation leaves the batch status untouched', async () => {
      const { monitorId, batchId } = await seedConfirmedMonitor();
      await seedPendingSensorEvent(monitorId, true);

      await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});

      const { Batches } = cds.entities('trace');
      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      chai(batch.status).to.equal('MINTED');
    });

    it('a breach does NOT override an already-RECALLED batch', async () => {
      const { monitorId, batchId } = await seedConfirmedMonitor();
      const { Batches } = cds.entities('trace');
      await UPDATE.entity(Batches).set({ status: 'RECALLED' }).where({ ID: batchId });
      await seedPendingSensorEvent(monitorId, false);

      await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});

      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      chai(batch.status).to.equal('RECALLED');
    });

    it('a quarantined batch can no longer be transferred', async () => {
      const { batchId } = await seedConfirmedMonitor();
      const { Batches, OnChainAssets, Participants } = cds.entities('trace');
      await UPDATE.entity(Batches).set({ status: 'QUARANTINE' }).where({ ID: batchId });
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(), batch_ID: batchId, policyId: POLICY, assetName: '01',
        currentUtxoRef: 't'.repeat(64) + '#0', step: 0,
        manufacturerVkh: VKH_ORACLE, currentHolder: VKH_ORACLE,
      });
      const targetId = cds.utils.uuid();
      await INSERT.into(Participants).entries({
        ID: targetId, name: 'D', role: 'Distributor', address: ADDR, vkh: VKH_OTHER, isActive: true,
      });

      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/TransferBatch',
          { batchId, toParticipantId: targetId, transferReason: 'x', transferNotes: '',
            walletAddress: ADDR, walletVkh: VKH_ORACLE });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------
  // VerifyBatch — cold-chain integrity surfacing (public read)
  // ---------------------------------------------------------------------------
  describe('VerifyBatch (cold-chain summary)', () => {
    // Seed a verifiable batch (+asset, no events so getTxStatus is never called)
    // and an optional CONFIRMED monitor. Returns the fingerprint.
    async function seedVerifiable(monitorExtra: any | null) {
      const { Batches, OnChainAssets, ConditionMonitors } = cds.entities('trace');
      const batchId = cds.utils.uuid();
      const fingerprint = 'asset1' + Math.random().toString(36).slice(2).padEnd(38, 'z').slice(0, 38);
      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-VC', product: 'Vaccine', status: 'MINTED', originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: cds.utils.uuid(), batch_ID: batchId, policyId: POLICY, assetName: '01',
        fingerprint, step: 0, currentHolder: VKH_ORACLE,
      });
      if (monitorExtra) {
        await INSERT.into(ConditionMonitors).entries({
          ID: cds.utils.uuid(), batch_ID: batchId, oracleVkh: VKH_ORACLE, batchIdHex: '01',
          policyId: POLICY, scriptAddress: SCRIPT_ADDR, seedTxHash: SEED_TX, seedIdx: 0,
          minMilliC: 2000, maxMilliC: 8000, readingCount: 0, breachCount: 0,
          commitRoot: sha256Hex('g'), breached: false, status: 'CONFIRMED', ...monitorExtra,
        });
      }
      return fingerprint;
    }

    it('reports breached=true and isValid=false when a monitor recorded an excursion', async () => {
      const fp = await seedVerifiable({ breached: true, breachCount: 2, readingCount: 10 });

      const { status, data } = await cdsTest.get(
        `/odata/v4/trace/VerifyBatch(batchIdOrFingerprint='${fp}')`);
      chai(status).to.equal(200);
      chai(data.coldChain.monitored).to.equal(true);
      chai(data.coldChain.breached).to.equal(true);
      chai(data.coldChain.breachCount).to.equal(2);
      chai(data.coldChain.readingCount).to.equal(10);
      chai(data.coldChain.minMilliC).to.equal(2000);
      chai(data.isValid).to.equal(false); // breach invalidates the batch
    });

    it('reports breached=false / monitored=true for a clean monitor', async () => {
      const fp = await seedVerifiable({ breached: false, breachCount: 0, readingCount: 5 });

      const { data } = await cdsTest.get(
        `/odata/v4/trace/VerifyBatch(batchIdOrFingerprint='${fp}')`);
      chai(data.coldChain.monitored).to.equal(true);
      chai(data.coldChain.breached).to.equal(false);
      chai(data.coldChain.readingCount).to.equal(5);
      chai(data.isValid).to.equal(true); // no events + clean cold chain
    });

    it('reports monitored=false when the batch has no monitor', async () => {
      const fp = await seedVerifiable(null);

      const { data } = await cdsTest.get(
        `/odata/v4/trace/VerifyBatch(batchIdOrFingerprint='${fp}')`);
      chai(data.coldChain.monitored).to.equal(false);
      chai(data.coldChain.breached).to.equal(false);
      chai(data.coldChain.monitorCount).to.equal(0);
    });
  });

  // ---------------------------------------------------------------------------
  // In-flight guard + retry
  // ---------------------------------------------------------------------------
  describe('in-flight guard + retry', () => {
    async function seedInflightEvent(monitorId: string, batchId: string, status: string, eventType = 'SENSOR_ATTESTATION') {
      const { ProofEvents } = cds.entities('trace');
      const evtId = cds.utils.uuid();
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId, eventType, monitorId,
        status, payloadDigest: sha256Hex('inflight'),
      });
      return evtId;
    }

    it('RecordSensorReadings is blocked while a SENSOR_ATTESTATION is PENDING', async () => {
      const { monitorId, batchId } = await seedConfirmedMonitor();
      await seedInflightEvent(monitorId, batchId, 'PENDING');
      ca.recordReadings.mockResolvedValue({ buildId: 'b', unsignedCbor: 'c', txBodyHash: 'h' });

      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RecordSensorReadings',
          { monitorId, readingsJson: JSON.stringify([{ milliValue: 5000, recordedAt: '2026-01-01T00:00:00.000Z' }]),
            walletAddress: ADDR, walletVkh: VKH_ORACLE });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
      expect(ca.recordReadings).not.toHaveBeenCalled();
    });

    it('RecordSensorReadings is blocked while a FAILED event is unresolved', async () => {
      const { monitorId, batchId } = await seedConfirmedMonitor();
      await seedInflightEvent(monitorId, batchId, 'FAILED');
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/RecordSensorReadings',
          { monitorId, readingsJson: JSON.stringify([{ milliValue: 5000, recordedAt: '2026-01-01T00:00:00.000Z' }]),
            walletAddress: ADDR, walletVkh: VKH_ORACLE });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
    });

    it('CloseColdChainMonitor is blocked while a tx is in flight', async () => {
      const { monitorId, batchId } = await seedConfirmedMonitor();
      await seedInflightEvent(monitorId, batchId, 'SUBMITTED');
      ca.closeMonitor.mockResolvedValue({ buildId: 'b', unsignedCbor: 'c', txBodyHash: 'h' });
      let threw = false;
      try {
        await cdsTest.post('/odata/v4/trace/CloseColdChainMonitor',
          { monitorId, walletAddress: ADDR, walletVkh: VKH_ORACLE });
      } catch (err: any) { threw = true; chai(err.response.status).to.equal(409); }
      chai(threw).to.equal(true);
      expect(ca.closeMonitor).not.toHaveBeenCalled();
    });

    it('RetryFailedTransaction rebuilds a FAILED SENSOR_ATTESTATION with recomputed counts', async () => {
      const { monitorId, batchId } = await seedConfirmedMonitor({ readingCount: 5, breachCount: 1 });
      const { ProofEvents, ConditionReadings } = cds.entities('trace');
      const targetRoot = sha256Hex('target');
      const evtId = cds.utils.uuid();
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId, eventType: 'SENSOR_ATTESTATION', monitorId,
        status: 'FAILED', payloadDigest: targetRoot, errorMessage: 'old fail',
      });
      // Two uncommitted readings (1 breach) belonging to the failed event.
      await INSERT.into(ConditionReadings).entries([
        { ID: cds.utils.uuid(), monitor_ID: monitorId, metric: 'TEMPERATURE', milliValue: 5000,
          recordedAt: '2026-01-01T00:00:00.000Z', withinSpec: true, leafHash: 'l1' },
        { ID: cds.utils.uuid(), monitor_ID: monitorId, metric: 'TEMPERATURE', milliValue: 14000,
          recordedAt: '2026-01-01T01:00:00.000Z', withinSpec: false, leafHash: 'l2' },
      ]);
      ca.recordReadings.mockResolvedValue({ buildId: 'b-retry', unsignedCbor: 'c', txBodyHash: 'h' });

      const { status, data } = await cdsTest.post('/odata/v4/trace/RetryFailedTransaction',
        { proofEventId: evtId, walletAddress: ADDR, walletVkh: VKH_ORACLE });
      chai(status).to.equal(200);
      chai(data.buildId).to.equal('b-retry');

      const evt = await SELECT.one.from(ProofEvents).where({ ID: evtId });
      chai(evt.status).to.equal('PENDING');
      chai(evt.errorMessage).to.equal(null);

      const arg = ca.recordReadings.mock.calls[0][0];
      chai(arg.newReadingCount).to.equal(7);   // 5 + 2 uncommitted
      chai(arg.newBreachCount).to.equal(2);     // 1 + 1 breach
      chai(arg.newBreached).to.equal(true);
      chai(arg.newCommitRoot).to.equal(targetRoot); // unchanged target root
    });

    it('RetryFailedTransaction rebuilds a FAILED MONITOR_CLOSE', async () => {
      const { monitorId, batchId } = await seedConfirmedMonitor();
      const { ProofEvents } = cds.entities('trace');
      const evtId = cds.utils.uuid();
      await INSERT.into(ProofEvents).entries({
        ID: evtId, batch_ID: batchId, eventType: 'MONITOR_CLOSE', monitorId,
        status: 'FAILED', payloadDigest: sha256Hex('c'),
      });
      ca.closeMonitor.mockResolvedValue({ buildId: 'b-close-retry', unsignedCbor: 'c', txBodyHash: 'h' });

      const { status } = await cdsTest.post('/odata/v4/trace/RetryFailedTransaction',
        { proofEventId: evtId, walletAddress: ADDR, walletVkh: VKH_ORACLE });
      chai(status).to.equal(200);
      expect(ca.closeMonitor).toHaveBeenCalled();

      const evt = await SELECT.one.from(ProofEvents).where({ ID: evtId });
      chai(evt.status).to.equal('PENDING');
    });
  });

  // ---------------------------------------------------------------------------
  // Full sequential flow
  // ---------------------------------------------------------------------------
  describe('end-to-end', () => {
    it('init → confirm → record → confirm advances the monitor through the whole lifecycle', async () => {
      const batchId = await seedBatch();
      mockInit();

      // 1) Init
      const init = await cdsTest.post('/odata/v4/trace/InitColdChainMonitor',
        { batchId, minMilliC: 2000, maxMilliC: 8000, walletAddress: ADDR, walletVkh: VKH_ORACLE });
      const monitorId = init.data.monitorId;

      // 2) Submit the init tx
      ca.submitSigned.mockResolvedValue({ txHash: MON_TX, submissionId: 'sub-init', status: 'submitted' });
      await cdsTest.post('/odata/v4/trace/SubmitSigned',
        { signingRequestId: init.data.signingRequestId, signedTxCbor: 'w' });

      // 3) Confirm the init → monitor CONFIRMED + currentUtxoRef
      ca.checkSubmissionStatus.mockResolvedValue({ status: 'confirmed', txHash: MON_TX, errorMessage: null });
      ca.getAssetOutputIndex.mockResolvedValue(0);
      await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});

      const { ConditionMonitors } = cds.entities('trace');
      let mon = await SELECT.one.from(ConditionMonitors).where({ ID: monitorId });
      chai(mon.status).to.equal('CONFIRMED');
      chai(mon.currentUtxoRef).to.equal(`${MON_TX}#0`);

      // 4) Record a breach reading
      ca.recordReadings.mockResolvedValue({ buildId: 'b-rec', unsignedCbor: 'c', txBodyHash: 'h' });
      const rec = await cdsTest.post('/odata/v4/trace/RecordSensorReadings',
        { monitorId, readingsJson: JSON.stringify([
          { metric: 'TEMPERATURE', milliValue: 15000, recordedAt: '2026-02-01T00:00:00.000Z' },
        ]), walletAddress: ADDR, walletVkh: VKH_ORACLE });
      chai(rec.data.breached).to.equal(true);

      // 5) Submit + confirm the record tx → monitor advances + latched breach
      const recTx = 'a'.repeat(64);
      ca.submitSigned.mockResolvedValue({ txHash: recTx, submissionId: 'sub-rec', status: 'submitted' });
      await cdsTest.post('/odata/v4/trace/SubmitSigned',
        { signingRequestId: rec.data.signingRequestId, signedTxCbor: 'w' });
      ca.checkSubmissionStatus.mockResolvedValue({ status: 'confirmed', txHash: recTx, errorMessage: null });
      ca.getAssetOutputIndex.mockResolvedValue(0);
      await cdsTest.post('/odata/v4/trace/CheckPendingTransactions', {});

      mon = await SELECT.one.from(ConditionMonitors).where({ ID: monitorId });
      chai(mon.readingCount).to.equal(1);
      chai(mon.breachCount).to.equal(1);
      chai(mon.breached).to.equal(true);
      chai(mon.currentUtxoRef).to.equal(`${recTx}#0`);
    });
  });
});
