/**
 * Smoke tests for TraceService against an in-memory SQLite (cds.test bootstrap).
 *
 * Strictly DB-only paths — every test is constructed so that no chain-adapter
 * function that would call into ODATANO ever runs:
 *   - Participants/Batches CRUD via the OData V4 projection
 *   - ResolveWallet hits the DB fast path (existing participant → no on-chain lookup)
 *   - VerifyBatch uses PENDING-only events so getTxStatus is never called
 *
 * On-chain action handlers (MintBatchNft / TransferBatch / SubmitSigned / ...)
 * are out of scope here; they need service mocks and are tracked separately.
 */

import cds from '@sap/cds';
const { INSERT } = cds.ql;

describe('TraceService — smoke (DB-only paths)', () => {
  jest.setTimeout(60000);

  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  beforeEach(async () => {
    await test.data.reset();
  });

  describe('Participants entity', () => {
    it('GET /Participants — empty initially', async () => {
      const { status, data } = await test.get('/odata/v4/trace/Participants');
      expect(status).to.equal(200);
      expect(data.value).to.be.an('array').that.is.empty;
    });

    it('INSERT + GET round-trips with default values', async () => {
      const { Participants } = cds.entities('trace');
      await INSERT.into(Participants).entries({
        ID: '11111111-1111-1111-1111-111111111111',
        name: 'Acme Pharma',
        role: 'Manufacturer',
        address: 'addr_test1qq' + 'a'.repeat(99),
        vkh: 'a'.repeat(56),
      });

      const { status, data } = await test.get(
        "/odata/v4/trace/Participants?$filter=name eq 'Acme Pharma'"
      );
      expect(status).to.equal(200);
      expect(data.value).to.have.lengthOf(1);
      const p = data.value[0];
      expect(p.role).to.equal('Manufacturer');
      expect(p.isActive).to.equal(true);
      expect(p.registrationStatus).to.equal('NONE');
    });
  });

  describe('Batches entity', () => {
    it('GET /Batches — empty initially', async () => {
      const { status, data } = await test.get('/odata/v4/trace/Batches');
      expect(status).to.equal(200);
      expect(data.value).to.be.an('array').that.is.empty;
    });

    it('$expand returns nested compositions', async () => {
      const { Batches, OnChainAssets, ProofEvents } = cds.entities('trace');
      await INSERT.into(Batches).entries({
        ID: '22222222-2222-2222-2222-222222222222',
        batchNumber: 'B-001',
        product: 'Vaccine-X',
        status: 'DRAFT',
        originPayload: '{"lot":"A1"}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: '33333333-3333-3333-3333-333333333333',
        batch_ID: '22222222-2222-2222-2222-222222222222',
        policyId: 'a'.repeat(56),
        assetName: '01',
        fingerprint: 'asset1' + 'x'.repeat(38),
        step: 0,
      });
      await INSERT.into(ProofEvents).entries({
        ID: '44444444-4444-4444-4444-444444444444',
        batch_ID: '22222222-2222-2222-2222-222222222222',
        eventType: 'MINT',
        payloadDigest: 'd'.repeat(64),
        status: 'PENDING',
      });

      const { status, data } = await test.get(
        '/odata/v4/trace/Batches?$expand=onChainAsset,proofEvents'
      );
      expect(status).to.equal(200);
      expect(data.value).to.have.lengthOf(1);
      const batch = data.value[0];
      expect(batch.batchNumber).to.equal('B-001');
      expect(batch.onChainAsset).to.exist;
      expect(batch.onChainAsset.assetName).to.equal('01');
      expect(batch.proofEvents).to.have.lengthOf(1);
      expect(batch.proofEvents[0].status).to.equal('PENDING');
    });
  });

  describe('ResolveWallet action', () => {
    it('rejects with 400 when walletAddress or walletVkh is missing', async () => {
      let threw = false;
      try {
        await test.post('/odata/v4/trace/ResolveWallet', {
          walletAddress: '',
          walletVkh: '',
        });
      } catch (err: any) {
        threw = true;
        expect(err.response.status).to.equal(400);
      }
      expect(threw).to.equal(true);
    });

    it('returns source="db" when the wallet vkh matches an active participant', async () => {
      const { Participants } = cds.entities('trace');
      const vkh = 'd'.repeat(56);
      await INSERT.into(Participants).entries({
        ID: '55555555-5555-5555-5555-555555555555',
        name: 'Pharma North',
        role: 'Pharmacy',
        address: 'addr_test1abc',
        vkh,
        isActive: true,
      });

      const { status, data } = await test.post('/odata/v4/trace/ResolveWallet', {
        walletAddress: 'addr_test1abc',
        walletVkh: vkh,
      });
      expect(status).to.equal(200);
      expect(data.source).to.equal('db');
      expect(data.participantId).to.equal('55555555-5555-5555-5555-555555555555');
      expect(data.participantName).to.equal('Pharma North');
    });
  });

  describe('VerifyBatch function (GET)', () => {
    it('returns 404 when no on-chain asset exists', async () => {
      let threw = false;
      try {
        await test.get(
          "/odata/v4/trace/VerifyBatch(batchIdOrFingerprint='asset1nonexistent')"
        );
      } catch (err: any) {
        threw = true;
        expect(err.response.status).to.equal(404);
      }
      expect(threw).to.equal(true);
    });

    it('returns the custody trail (PENDING events → awaiting_signature)', async () => {
      const { Batches, OnChainAssets, ProofEvents } = cds.entities('trace');
      const batchId = '66666666-6666-6666-6666-666666666666';
      const fingerprint = 'asset1' + 'y'.repeat(38);

      await INSERT.into(Batches).entries({
        ID: batchId,
        batchNumber: 'B-VERIFY',
        product: 'Drug-Y',
        status: 'DRAFT',
        originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: '77777777-7777-7777-7777-777777777777',
        batch_ID: batchId,
        policyId: 'b'.repeat(56),
        assetName: '01',
        fingerprint,
        step: 0,
        currentHolder: 'e'.repeat(56),
      });
      await INSERT.into(ProofEvents).entries({
        ID: '88888888-8888-8888-8888-888888888888',
        batch_ID: batchId,
        eventType: 'MINT',
        payloadDigest: 'p'.repeat(64),
        status: 'PENDING',
        signerVkh: 'e'.repeat(56),
      });

      const { status, data } = await test.get(
        `/odata/v4/trace/VerifyBatch(batchIdOrFingerprint='${fingerprint}')`
      );
      expect(status).to.equal(200);
      expect(data.fingerprint).to.equal(fingerprint);
      expect(data.step).to.equal(0);
      expect(data.isValid).to.equal(false); // no CONFIRMED events yet
      expect(data.onChainMatch).to.equal(false);
      expect(data.steps).to.have.lengthOf(1);
      expect(data.steps[0].eventType).to.equal('MINT');
      expect(data.steps[0].onChainStatus).to.equal('awaiting_signature');
    });
  });
});
