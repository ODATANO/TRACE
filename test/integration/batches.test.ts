/**
 * Integration tests focused on the Batches entity and the DB-only branches of
 * VerifyBatch. Every test is constructed so no chain-adapter call into ODATANO
 * is required (no CONFIRMED ProofEvents — only PENDING / SUBMITTED / FAILED,
 * which short-circuit before the getTxStatus call site in trace-service.ts).
 */

import cds from '@sap/cds';
const { INSERT, UPDATE, DELETE, SELECT } = cds.ql;

describe('Batches entity — DB-only paths', () => {
  jest.setTimeout(60000);

  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  beforeEach(async () => {
    await test.data.reset();
  });

  describe('OData V4 CRUD via projection', () => {
    it('POST /Batches creates a row and auto-fills createdAt/modifiedAt', async () => {
      const { status, data } = await test.post('/odata/v4/trace/Batches', {
        ID: 'aaaaaaaa-1111-1111-1111-111111111111',
        batchNumber: 'B-NEW-001',
        product: 'Vaccine-Z',
        status: 'DRAFT',
        originPayload: '{"manufacturer":"Acme"}',
      });
      expect(status).to.equal(201);
      expect(data.batchNumber).to.equal('B-NEW-001');
      expect(data.status).to.equal('DRAFT');
      // @cds.on.insert: $now auto-fills these
      expect(data.createdAt).to.be.a('string').that.is.not.empty;
      expect(data.modifiedAt).to.be.a('string').that.is.not.empty;
    });

    it('PATCH /Batches(ID) updates status (DRAFT → MINTED)', async () => {
      const id = 'aaaaaaaa-2222-2222-2222-222222222222';
      const { Batches } = cds.entities('trace');
      await INSERT.into(Batches).entries({
        ID: id,
        batchNumber: 'B-PATCH',
        product: 'Pill-A',
        status: 'DRAFT',
        originPayload: '{}',
      });

      const { status } = await test.patch(`/odata/v4/trace/Batches(${id})`, {
        status: 'MINTED',
      });
      expect(status).to.equal(200);

      const after = await SELECT.one.from(Batches).where({ ID: id });
      expect(after.status).to.equal('MINTED');
    });

    it('DELETE /Batches(ID) cascades to compositions (OnChainAssets, ProofEvents)', async () => {
      const id = 'aaaaaaaa-3333-3333-3333-333333333333';
      const { Batches, OnChainAssets, ProofEvents } = cds.entities('trace');
      await INSERT.into(Batches).entries({
        ID: id,
        batchNumber: 'B-DEL',
        product: 'Syrup-B',
        status: 'DRAFT',
        originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: 'aaaaaaaa-3333-aaaa-aaaa-111111111111',
        batch_ID: id,
        policyId: 'a'.repeat(56),
        assetName: '01',
        fingerprint: 'asset1' + 'k'.repeat(38),
        step: 0,
      });
      await INSERT.into(ProofEvents).entries({
        ID: 'aaaaaaaa-3333-aaaa-aaaa-222222222222',
        batch_ID: id,
        eventType: 'MINT',
        payloadDigest: 'd'.repeat(64),
        status: 'PENDING',
      });

      const { status } = await test.delete(`/odata/v4/trace/Batches(${id})`);
      expect(status).to.equal(204);

      const lingeringAsset = await SELECT.one.from(OnChainAssets).where({ batch_ID: id });
      const lingeringEvent = await SELECT.one.from(ProofEvents).where({ batch_ID: id });
      expect(lingeringAsset).to.be.undefined;
      expect(lingeringEvent).to.be.undefined;
    });
  });

  describe('Query options', () => {
    beforeEach(async () => {
      const { Batches } = cds.entities('trace');
      await INSERT.into(Batches).entries([
        { ID: 'bbbbbbbb-0001-0001-0001-000000000001', batchNumber: 'B-Q-1', product: 'A', status: 'DRAFT',      originPayload: '{}' },
        { ID: 'bbbbbbbb-0002-0002-0002-000000000002', batchNumber: 'B-Q-2', product: 'B', status: 'MINTED',     originPayload: '{}' },
        { ID: 'bbbbbbbb-0003-0003-0003-000000000003', batchNumber: 'B-Q-3', product: 'C', status: 'IN_TRANSIT', originPayload: '{}' },
        { ID: 'bbbbbbbb-0004-0004-0004-000000000004', batchNumber: 'B-Q-4', product: 'D', status: 'DELIVERED',  originPayload: '{}' },
        { ID: 'bbbbbbbb-0005-0005-0005-000000000005', batchNumber: 'B-Q-5', product: 'E', status: 'RECALLED',   originPayload: '{}' },
      ]);
    });

    it('$filter narrows by status', async () => {
      const { status, data } = await test.get(
        "/odata/v4/trace/Batches?$filter=status eq 'MINTED'"
      );
      expect(status).to.equal(200);
      expect(data.value).to.have.lengthOf(1);
      expect(data.value[0].batchNumber).to.equal('B-Q-2');
    });

    it('$orderby batchNumber desc returns reverse-lexical order', async () => {
      const { status, data } = await test.get(
        '/odata/v4/trace/Batches?$orderby=batchNumber desc'
      );
      expect(status).to.equal(200);
      const numbers = data.value.map((b: any) => b.batchNumber);
      expect(numbers).to.deep.equal(['B-Q-5', 'B-Q-4', 'B-Q-3', 'B-Q-2', 'B-Q-1']);
    });

    it('$select narrows to chosen columns', async () => {
      const { status, data } = await test.get(
        '/odata/v4/trace/Batches?$select=batchNumber,status&$orderby=batchNumber'
      );
      expect(status).to.equal(200);
      const first = data.value[0];
      expect(first).to.have.property('batchNumber');
      expect(first).to.have.property('status');
      expect(first).to.not.have.property('product');
      expect(first).to.not.have.property('originPayload');
    });

    it('$count counts filtered rows', async () => {
      const { status, data } = await test.get(
        "/odata/v4/trace/Batches/$count?$filter=status ne 'RECALLED'"
      );
      expect(status).to.equal(200);
      // $count returns a plain integer in the body
      expect(Number(data)).to.equal(4);
    });
  });

  describe('Compositions', () => {
    it('$expand pulls onChainAsset, proofEvents and documentAnchors together', async () => {
      const { Batches, OnChainAssets, ProofEvents, DocumentAnchors } = cds.entities('trace');
      const id = 'cccccccc-1111-1111-1111-111111111111';

      await INSERT.into(Batches).entries({
        ID: id,
        batchNumber: 'B-EXP',
        product: 'Compound-K',
        status: 'IN_TRANSIT',
        originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: 'cccccccc-1111-aaaa-aaaa-111111111111',
        batch_ID: id,
        policyId: 'c'.repeat(56),
        assetName: '02',
        fingerprint: 'asset1' + 'z'.repeat(38),
        step: 1,
      });
      await INSERT.into(ProofEvents).entries([
        {
          ID: 'cccccccc-1111-eeee-eeee-111111111111',
          batch_ID: id,
          eventType: 'MINT',
          payloadDigest: 'd'.repeat(64),
          status: 'CONFIRMED',
          onChainTxHash: 't'.repeat(64),
        },
        {
          ID: 'cccccccc-1111-eeee-eeee-222222222222',
          batch_ID: id,
          eventType: 'TRANSFER',
          payloadDigest: 'e'.repeat(64),
          status: 'PENDING',
        },
      ]);
      await INSERT.into(DocumentAnchors).entries({
        ID: 'cccccccc-1111-dddd-dddd-111111111111',
        batch_ID: id,
        documentHash: 'h'.repeat(64),
        documentType: 'CERTIFICATE_OF_ANALYSIS',
        visibility: 'PUBLIC',
        status: 'PENDING',
      });

      const { status, data } = await test.get(
        `/odata/v4/trace/Batches(${id})?$expand=onChainAsset,proofEvents,documentAnchors`
      );
      expect(status).to.equal(200);
      expect(data.onChainAsset).to.exist;
      expect(data.onChainAsset.step).to.equal(1);
      expect(data.proofEvents).to.have.lengthOf(2);
      expect(data.documentAnchors).to.have.lengthOf(1);
      expect(data.documentAnchors[0].documentType).to.equal('CERTIFICATE_OF_ANALYSIS');
    });

    it('UPDATE on a single ProofEvent flips status without affecting siblings', async () => {
      const { Batches, ProofEvents } = cds.entities('trace');
      const batchId = 'cccccccc-2222-2222-2222-222222222222';
      const evtId1 = 'cccccccc-2222-eeee-eeee-111111111111';
      const evtId2 = 'cccccccc-2222-eeee-eeee-222222222222';

      await INSERT.into(Batches).entries({
        ID: batchId,
        batchNumber: 'B-MULTI',
        product: 'M',
        status: 'DRAFT',
        originPayload: '{}',
      });
      await INSERT.into(ProofEvents).entries([
        { ID: evtId1, batch_ID: batchId, eventType: 'MINT',     payloadDigest: '1'.repeat(64), status: 'PENDING' },
        { ID: evtId2, batch_ID: batchId, eventType: 'TRANSFER', payloadDigest: '2'.repeat(64), status: 'PENDING' },
      ]);

      await UPDATE.entity(ProofEvents).set({ status: 'SUBMITTED' }).where({ ID: evtId1 });

      const updated = await SELECT.one.from(ProofEvents).where({ ID: evtId1 });
      const sibling = await SELECT.one.from(ProofEvents).where({ ID: evtId2 });
      expect(updated.status).to.equal('SUBMITTED');
      expect(sibling.status).to.equal('PENDING');
    });
  });

  describe('VerifyBatch (DB-only branches)', () => {
    it('looks up by batch UUID when no fingerprint matches (fallback path)', async () => {
      const { Batches, OnChainAssets, ProofEvents } = cds.entities('trace');
      const batchId = 'dddddddd-1111-1111-1111-111111111111';

      await INSERT.into(Batches).entries({
        ID: batchId,
        batchNumber: 'B-BY-UUID',
        product: 'X',
        status: 'DRAFT',
        originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: 'dddddddd-1111-aaaa-aaaa-111111111111',
        batch_ID: batchId,
        policyId: 'a'.repeat(56),
        assetName: '01',
        fingerprint: 'asset1' + 'm'.repeat(38),
        step: 0,
        currentHolder: 'a'.repeat(56),
      });
      await INSERT.into(ProofEvents).entries({
        ID: 'dddddddd-1111-eeee-eeee-111111111111',
        batch_ID: batchId,
        eventType: 'MINT',
        payloadDigest: 'p'.repeat(64),
        status: 'PENDING',
      });

      const { status, data } = await test.get(
        `/odata/v4/trace/VerifyBatch(batchIdOrFingerprint='${batchId}')`
      );
      expect(status).to.equal(200);
      expect(data.fingerprint).to.equal('asset1' + 'm'.repeat(38));
      expect(data.steps).to.have.lengthOf(1);
    });

    it('classifies SUBMITTED events as onChainStatus="pending"', async () => {
      const { Batches, OnChainAssets, ProofEvents } = cds.entities('trace');
      const batchId = 'dddddddd-2222-2222-2222-222222222222';
      const fp = 'asset1' + 'n'.repeat(38);

      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-SUB', product: 'S', status: 'IN_TRANSIT', originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: 'dddddddd-2222-aaaa-aaaa-111111111111',
        batch_ID: batchId,
        policyId: 'b'.repeat(56),
        assetName: '02',
        fingerprint: fp,
        step: 0,
      });
      await INSERT.into(ProofEvents).entries({
        ID: 'dddddddd-2222-eeee-eeee-111111111111',
        batch_ID: batchId,
        eventType: 'MINT',
        payloadDigest: 'p'.repeat(64),
        status: 'SUBMITTED',
        onChainTxHash: 't'.repeat(64),
      });

      const { data } = await test.get(
        `/odata/v4/trace/VerifyBatch(batchIdOrFingerprint='${fp}')`
      );
      expect(data.steps).to.have.lengthOf(1);
      expect(data.steps[0].onChainStatus).to.equal('pending');
      expect(data.isValid).to.equal(false);
    });

    it('classifies FAILED events as onChainStatus="failed"', async () => {
      const { Batches, OnChainAssets, ProofEvents } = cds.entities('trace');
      const batchId = 'dddddddd-3333-3333-3333-333333333333';
      const fp = 'asset1' + 'o'.repeat(38);

      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-FAIL', product: 'F', status: 'DRAFT', originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: 'dddddddd-3333-aaaa-aaaa-111111111111',
        batch_ID: batchId,
        policyId: 'c'.repeat(56),
        assetName: '03',
        fingerprint: fp,
        step: 0,
      });
      await INSERT.into(ProofEvents).entries({
        ID: 'dddddddd-3333-eeee-eeee-111111111111',
        batch_ID: batchId,
        eventType: 'MINT',
        payloadDigest: 'p'.repeat(64),
        status: 'FAILED',
        errorMessage: 'submission rejected',
      });

      const { data } = await test.get(
        `/odata/v4/trace/VerifyBatch(batchIdOrFingerprint='${fp}')`
      );
      expect(data.steps[0].onChainStatus).to.equal('failed');
      expect(data.isValid).to.equal(false);
    });

    it('returns documentAnchors in the response', async () => {
      const { Batches, OnChainAssets, DocumentAnchors } = cds.entities('trace');
      const batchId = 'dddddddd-4444-4444-4444-444444444444';
      const fp = 'asset1' + 'p'.repeat(38);

      await INSERT.into(Batches).entries({
        ID: batchId, batchNumber: 'B-DOC', product: 'D', status: 'DRAFT', originPayload: '{}',
      });
      await INSERT.into(OnChainAssets).entries({
        ID: 'dddddddd-4444-aaaa-aaaa-111111111111',
        batch_ID: batchId,
        policyId: 'd'.repeat(56),
        assetName: '04',
        fingerprint: fp,
        step: 0,
      });
      await INSERT.into(DocumentAnchors).entries([
        {
          ID: 'dddddddd-4444-dddd-dddd-111111111111',
          batch_ID: batchId,
          documentHash: 'h'.repeat(64),
          documentType: 'CERTIFICATE_OF_ANALYSIS',
          visibility: 'PUBLIC',
          status: 'PENDING',
        },
        {
          ID: 'dddddddd-4444-dddd-dddd-222222222222',
          batch_ID: batchId,
          documentHash: 'g'.repeat(64),
          documentType: 'COLD_CHAIN',
          visibility: 'REGULATOR_ONLY',
          status: 'PENDING',
        },
      ]);

      const { data } = await test.get(
        `/odata/v4/trace/VerifyBatch(batchIdOrFingerprint='${fp}')`
      );
      expect(data.documentAnchors).to.have.lengthOf(2);
      const types = data.documentAnchors.map((d: any) => d.documentType).sort();
      expect(types).to.deep.equal(['CERTIFICATE_OF_ANALYSIS', 'COLD_CHAIN']);
    });
  });
});
