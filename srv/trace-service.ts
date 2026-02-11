import cds from '@sap/cds';
import * as chainAdapter from './lib/chain-adapter';
import { computeDigest } from './lib/digest';

const LOG = cds.log('trace');
const POLL_INTERVAL_MS = 30_000; // 30 seconds

export default class TraceService extends cds.ApplicationService {

  init() {
    const { Batches, Participants, OnChainAssets, ProofEvents, DocumentAnchors } = this.entities;

    // -----------------------------------------------------------------------
    // MintBatchNft — manufacturer mints a batch NFT on Cardano
    // -----------------------------------------------------------------------
    this.on('MintBatchNft', async (req) => {
      const { batchId, walletAddress, walletVkh } =
        req.data as { batchId: string; walletAddress: string; walletVkh: string };

      if (!walletAddress || !walletVkh) return req.reject(400, `Wallet address and VKH are required (connect wallet first)`);

      const batch = await SELECT.one.from(Batches).where({ ID: batchId });

      if (!batch) return req.reject(404, `Batch ${batchId} not found`);
      if (batch.status !== 'DRAFT') return req.reject(409, `Batch status must be DRAFT, is ${batch.status}`);

      const existingAsset = await SELECT.one.from(OnChainAssets).where({ batch_ID: batchId });
      if (existingAsset) return req.reject(409, `Batch already has an on-chain asset`);

      const digest = batch.originPayload
        ? computeDigest(JSON.parse(batch.originPayload))
        : '';

      const result = await chainAdapter.mintBatchNft({
        senderAddress: walletAddress,
        manufacturerVkh: walletVkh,
        batchId: batch.batchNumber,
        originDigest: digest
      });

      // Create signing request for CIP-30 wallet flow
      const signingReq = await chainAdapter.createSigningRequest(result.buildId);

      await INSERT.into(OnChainAssets).entries({
        batch_ID: batchId,
        policyId: result.policyId,
        assetName: result.assetName,
        fingerprint: result.fingerprint || null,
        step: 0,
        manufacturerVkh: walletVkh,
        currentHolder: walletVkh
      });

      // Set the minter as manufacturer + current holder
      const minterParticipant = await SELECT.one.from(Participants)
        .where({ vkh: walletVkh, isActive: true }).columns('ID');
      if (minterParticipant) {
        await UPDATE(Batches).set({
          manufacturer_ID: batch.manufacturer_ID || minterParticipant.ID,
          currentHolder_ID: minterParticipant.ID
        }).where({ ID: batchId });
      }

      await INSERT.into(ProofEvents).entries({
        batch_ID: batchId,
        eventType: 'MINT',
        payloadDigest: digest,
        signerVkh: walletVkh,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        status: 'PENDING'
      });

      return {
        policyId: result.policyId,
        assetName: result.assetName,
        fingerprint: result.fingerprint || null,
        unsignedCbor: signingReq.unsignedTxCbor,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        txBodyHash: signingReq.txBodyHash
      };
    });

    // -----------------------------------------------------------------------
    // TransferBatch — transfer custody to the next participant
    // -----------------------------------------------------------------------
    this.on('TransferBatch', async (req) => {
      const { batchId, toParticipantId, transferReason, transferNotes, walletAddress, walletVkh } =
        req.data as {
          batchId: string;
          toParticipantId: string;
          transferReason: string;
          transferNotes: string;
          walletAddress: string;
          walletVkh: string;
        };

      if (!walletAddress || !walletVkh) return req.reject(400, `Wallet address and VKH are required (connect wallet first)`);

      const batch = await SELECT.one.from(Batches).where({ ID: batchId });

      if (!batch) return req.reject(404, `Batch ${batchId} not found`);
      if (!['MINTED', 'IN_TRANSIT'].includes(batch.status)) {
        return req.reject(409, `Batch status must be MINTED or IN_TRANSIT, is ${batch.status}`);
      }

      const asset = await SELECT.one.from(OnChainAssets).where({ batch_ID: batchId });
      if (!asset) return req.reject(409, `No on-chain asset found for batch`);
      if (!asset.currentUtxoRef) return req.reject(409, `No current UTxO reference — mint not yet confirmed`);
      if (!asset.manufacturerVkh) return req.reject(409, `On-chain asset missing manufacturerVkh — was it minted correctly?`);

      // Ownership check: wallet VKH must match on-chain current holder
      if (asset.currentHolder && asset.currentHolder !== walletVkh) {
        return req.reject(403, `Only the current holder can transfer this batch`);
      }

      const targetParticipant = await SELECT.one.from(Participants).where({ ID: toParticipantId });
      if (!targetParticipant) return req.reject(404, `Target participant ${toParticipantId} not found`);
      if (!targetParticipant.vkh) return req.reject(400, `Target participant has no verification key hash`);

      const [scriptTxHash, indexStr] = asset.currentUtxoRef.split('#');
      const scriptOutputIndex = parseInt(indexStr, 10);

      const result = await chainAdapter.transferBatch({
        senderAddress: walletAddress,
        manufacturerVkh: asset.manufacturerVkh,
        currentHolderVkh: walletVkh,
        nextHolderVkh: targetParticipant.vkh,
        batchIdHex: chainAdapter.toHex(batch.batchNumber),
        currentStep: asset.step,
        scriptTxHash,
        scriptOutputIndex
      });

      // Create signing request for CIP-30 wallet flow
      const signingReq = await chainAdapter.createSigningRequest(result.buildId);

      // Compute digest from transfer metadata
      const transferPayload = {
        reason: transferReason || 'ROUTINE',
        notes: transferNotes || '',
        timestamp: new Date().toISOString()
      };
      const digest = computeDigest(transferPayload);

      await INSERT.into(ProofEvents).entries({
        batch_ID: batchId,
        eventType: 'TRANSFER',
        payloadDigest: digest,
        schema: 'TRACE_TRANSFER_V1',
        signerVkh: walletVkh,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        status: 'PENDING'
      });

      // Optimistically update current holder (display + on-chain truth)
      await UPDATE(Batches)
        .set({ currentHolder_ID: toParticipantId })
        .where({ ID: batchId });
      await UPDATE(OnChainAssets)
        .set({ currentHolder: targetParticipant.vkh })
        .where({ batch_ID: batchId });

      return {
        unsignedCbor: signingReq.unsignedTxCbor,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        txBodyHash: signingReq.txBodyHash
      };
    });

    // -----------------------------------------------------------------------
    // SubmitSigned — submit an externally signed transaction
    // -----------------------------------------------------------------------
    this.on('SubmitSigned', async (req) => {
      const { signingRequestId, signedTxCbor } =
        req.data as { signingRequestId: string; signedTxCbor: string };

      const result = await chainAdapter.submitSigned(signingRequestId, signedTxCbor);

      // Link the PENDING ProofEvent that matches this signingRequestId
      const pendingEvent = await SELECT.one.from(ProofEvents)
        .where({ signingRequestId, status: 'PENDING' });

      if (pendingEvent) {
        await UPDATE(ProofEvents)
          .set({
            onChainTxHash: result.txHash,
            submissionId: result.submissionId,
            status: 'SUBMITTED'
          })
          .where({ ID: pendingEvent.ID });

        // Optimistic batch status update — tx was successfully submitted
        if (pendingEvent.eventType === 'MINT') {
          await UPDATE(Batches).set({ status: 'MINTED' }).where({ ID: pendingEvent.batch_ID });
        }
        if (pendingEvent.eventType === 'TRANSFER') {
          await UPDATE(Batches).set({ status: 'IN_TRANSIT' }).where({ ID: pendingEvent.batch_ID });
        }
      }

      // Also update any DocumentAnchor linked to this signingRequestId
      const pendingAnchor = await SELECT.one.from(DocumentAnchors)
        .where({ signingRequestId, status: 'PENDING' });
      if (pendingAnchor) {
        await UPDATE(DocumentAnchors)
          .set({
            onChainTxHash: result.txHash,
            submissionId: result.submissionId,
            status: 'SUBMITTED'
          })
          .where({ ID: pendingAnchor.ID });
      }

      return {
        txHash: result.txHash,
        submissionId: result.submissionId,
        status: 'SUBMITTED'
      };
    });

    // -----------------------------------------------------------------------
    // CheckPendingTransactions — poll ODATANO for confirmation status
    // -----------------------------------------------------------------------
    this.on('CheckPendingTransactions', async () => {
      const submitted = await SELECT.from(ProofEvents)
        .where({ status: 'SUBMITTED' });

      let confirmed = 0;
      let failed = 0;

      for (const evt of submitted) {
        if (!evt.submissionId) continue;

        const check = await chainAdapter.checkSubmissionStatus(evt.submissionId);
        const now = new Date().toISOString();

        if (check.status === 'confirmed') {
          await UPDATE(ProofEvents)
            .set({
              status: 'CONFIRMED',
              onChainTxHash: check.txHash ?? evt.onChainTxHash,
              lastCheckedAt: now
            })
            .where({ ID: evt.ID });

          await this._onConfirmed(evt, check.txHash ?? evt.onChainTxHash);
          confirmed++;

        } else if (check.status === 'failed') {
          await UPDATE(ProofEvents)
            .set({
              status: 'FAILED',
              errorMessage: check.errorMessage,
              lastCheckedAt: now
            })
            .where({ ID: evt.ID });
          failed++;

        } else {
          await UPDATE(ProofEvents)
            .set({ lastCheckedAt: now })
            .where({ ID: evt.ID });
        }
      }

      LOG.info(`Checked ${submitted.length} submissions: ${confirmed} confirmed, ${failed} failed`);
      return { checked: submitted.length, confirmed, failed };
    });

    // -----------------------------------------------------------------------
    // RetryFailedTransaction — rebuild tx for a failed ProofEvent
    // -----------------------------------------------------------------------
    this.on('RetryFailedTransaction', async (req) => {
      const { proofEventId, walletAddress, walletVkh } =
        req.data as { proofEventId: string; walletAddress: string; walletVkh: string };

      if (!walletAddress || !walletVkh) return req.reject(400, `Wallet address and VKH are required (connect wallet first)`);

      const evt = await SELECT.one.from(ProofEvents).where({ ID: proofEventId });
      if (!evt) return req.reject(404, `ProofEvent ${proofEventId} not found`);
      if (evt.status !== 'FAILED') return req.reject(409, `ProofEvent status must be FAILED, is ${evt.status}`);

      const batch = await SELECT.one.from(Batches).where({ ID: evt.batch_ID });
      if (!batch) return req.reject(404, `Associated batch not found`);

      if (evt.eventType === 'MINT') {
        const result = await chainAdapter.mintBatchNft({
          senderAddress: walletAddress,
          manufacturerVkh: walletVkh,
          batchId: batch.batchNumber,
          originDigest: evt.payloadDigest || ''
        });

        const signingReq = await chainAdapter.createSigningRequest(result.buildId);

        await UPDATE(ProofEvents)
          .set({ buildId: result.buildId, signingRequestId: signingReq.signingRequestId, status: 'PENDING', errorMessage: null })
          .where({ ID: evt.ID });

        return { buildId: result.buildId, signingRequestId: signingReq.signingRequestId, unsignedCbor: signingReq.unsignedTxCbor, txBodyHash: signingReq.txBodyHash };
      }

      if (evt.eventType === 'TRANSFER') {
        const asset = await SELECT.one.from(OnChainAssets).where({ batch_ID: batch.ID });
        if (!asset?.currentUtxoRef) return req.reject(409, `No current UTxO reference for retry`);
        if (!asset.manufacturerVkh) return req.reject(409, `On-chain asset missing manufacturerVkh`);

        const [scriptTxHash, indexStr] = asset.currentUtxoRef.split('#');

        const result = await chainAdapter.transferBatch({
          senderAddress: walletAddress,
          manufacturerVkh: asset.manufacturerVkh,
          currentHolderVkh: walletVkh,
          nextHolderVkh: evt.signerVkh,
          batchIdHex: chainAdapter.toHex(batch.batchNumber),
          currentStep: asset.step,
          scriptTxHash,
          scriptOutputIndex: parseInt(indexStr, 10)
        });

        const signingReq = await chainAdapter.createSigningRequest(result.buildId);

        await UPDATE(ProofEvents)
          .set({ buildId: result.buildId, signingRequestId: signingReq.signingRequestId, status: 'PENDING', errorMessage: null })
          .where({ ID: evt.ID });

        return { buildId: result.buildId, signingRequestId: signingReq.signingRequestId, unsignedCbor: signingReq.unsignedTxCbor, txBodyHash: signingReq.txBodyHash };
      }

      return req.reject(400, `Cannot retry event type ${evt.eventType}`);
    });

    // -----------------------------------------------------------------------
    // AnchorDocument — anchor a document hash on-chain via metadata tx
    // -----------------------------------------------------------------------
    this.on('AnchorDocument', async (req) => {
      const { batchId, documentHash, documentType, visibility, walletAddress, walletVkh } =
        req.data as { batchId: string; documentHash: string; documentType: string; visibility: string; walletAddress: string; walletVkh: string };

      if (!walletAddress || !walletVkh) return req.reject(400, `Wallet address and VKH are required (connect wallet first)`);

      const batch = await SELECT.one.from(Batches)
        .where({ ID: batchId })
        .columns('*', 'currentHolder_ID');
      if (!batch) return req.reject(404, `Batch ${batchId} not found`);

      const metadata = {
        674: {
          msg: [`TRACE:DOC_ANCHOR:${documentType}`],
          batch: batch.batchNumber,
          hash: documentHash,
          vis: visibility || 'PUBLIC'
        }
      };

      const result = await chainAdapter.anchorDocument({
        senderAddress: walletAddress,
        documentHash,
        metadataJson: JSON.stringify(metadata)
      });

      const signingReq = await chainAdapter.createSigningRequest(result.buildId);

      await INSERT.into(DocumentAnchors).entries({
        batch_ID: batchId,
        documentHash,
        documentType,
        visibility: visibility || 'PUBLIC',
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        status: 'PENDING'
      });

      await INSERT.into(ProofEvents).entries({
        batch_ID: batchId,
        eventType: 'DOCUMENT_ANCHOR',
        payloadDigest: documentHash,
        schema: documentType,
        signerVkh: walletVkh,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        status: 'PENDING'
      });

      return {
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        unsignedCbor: signingReq.unsignedTxCbor,
        txBodyHash: signingReq.txBodyHash
      };
    });

    // -----------------------------------------------------------------------
    // RecallBatch — recall a batch with on-chain proof (pharma compliance)
    // -----------------------------------------------------------------------
    this.on('RecallBatch', async (req) => {
      const { batchId, reason, walletAddress, walletVkh } =
        req.data as { batchId: string; reason: string; walletAddress: string; walletVkh: string };

      if (!walletAddress || !walletVkh) return req.reject(400, `Wallet address and VKH are required`);
      if (!reason) return req.reject(400, `Recall reason is required`);

      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      if (!batch) return req.reject(404, `Batch ${batchId} not found`);
      if (batch.status === 'DRAFT') return req.reject(409, `Cannot recall a DRAFT batch`);
      if (batch.status === 'RECALLED') return req.reject(409, `Batch is already recalled`);

      const metadata = {
        674: {
          msg: [`TRACE:RECALL:${reason.substring(0, 60)}`],
          batch: batch.batchNumber,
          reason: reason,
          recalledBy: walletVkh
        }
      };

      const result = await chainAdapter.anchorDocument({
        senderAddress: walletAddress,
        documentHash: computeDigest({ reason, batchId, timestamp: new Date().toISOString() }),
        metadataJson: JSON.stringify(metadata)
      });

      const signingReq = await chainAdapter.createSigningRequest(result.buildId);

      await INSERT.into(ProofEvents).entries({
        batch_ID: batchId,
        eventType: 'RECALL',
        payloadDigest: computeDigest({ reason }),
        schema: 'TRACE_RECALL_V1',
        signerVkh: walletVkh,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        status: 'PENDING'
      });

      // Set status immediately — recall is urgent
      await UPDATE(Batches).set({ status: 'RECALLED' }).where({ ID: batchId });

      return {
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        unsignedCbor: signingReq.unsignedTxCbor,
        txBodyHash: signingReq.txBodyHash
      };
    });

    // -----------------------------------------------------------------------
    // ConfirmReceipt — mark a batch as DELIVERED (business state only)
    // -----------------------------------------------------------------------
    this.on('ConfirmReceipt', async (req) => {
      const { batchId } = req.data as { batchId: string };

      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      if (!batch) return req.reject(404, `Batch ${batchId} not found`);
      if (batch.status !== 'IN_TRANSIT') return req.reject(409, `Batch must be IN_TRANSIT to confirm receipt, is ${batch.status}`);

      await UPDATE(Batches).set({ status: 'DELIVERED' }).where({ ID: batchId });
      return { status: 'DELIVERED' };
    });

    // -----------------------------------------------------------------------
    // VerifyBatch — public read-only verification of chain of custody
    // -----------------------------------------------------------------------
    this.on('VerifyBatch', async (req) => {
      const { batchIdOrFingerprint } = req.data as { batchIdOrFingerprint: string };

      let asset = await SELECT.one.from(OnChainAssets)
        .where({ fingerprint: batchIdOrFingerprint });

      if (!asset) {
        const batch = await SELECT.one.from(Batches)
          .where({ ID: batchIdOrFingerprint });
        if (batch) {
          asset = await SELECT.one.from(OnChainAssets)
            .where({ batch_ID: batch.ID });
        }
      }

      if (!asset) return req.reject(404, `No on-chain asset found for ${batchIdOrFingerprint}`);

      const events = await SELECT.from(ProofEvents)
        .where({ batch_ID: asset.batch_ID })
        .orderBy('createdAt asc');

      // For each confirmed event with a txHash, verify it exists on-chain
      const steps = [];
      for (const [idx, evt] of (events as any[]).entries()) {
        let onChainStatus = 'unknown';

        if (evt.onChainTxHash && evt.status === 'CONFIRMED') {
          try {
            const txStatus = await chainAdapter.getTxStatus(evt.onChainTxHash);
            onChainStatus = txStatus.status === 'confirmed' ? 'verified' : 'not_found';
          } catch {
            onChainStatus = 'check_failed';
          }
        } else if (evt.status === 'SUBMITTED') {
          onChainStatus = 'pending';
        } else if (evt.status === 'FAILED') {
          onChainStatus = 'failed';
        } else {
          onChainStatus = 'awaiting_signature';
        }

        steps.push({
          step: idx,
          holder: evt.signerVkh,
          eventType: evt.eventType,
          txHash: evt.onChainTxHash,
          status: evt.status,
          onChainStatus
        });
      }

      const allConfirmed = events.every((e: any) => e.status === 'CONFIRMED');
      const anyFailed = events.some((e: any) => e.status === 'FAILED');
      const allVerified = steps.every(s => s.onChainStatus === 'verified');

      // Fetch document anchors for this batch
      const anchors = await SELECT.from(DocumentAnchors)
        .where({ batch_ID: asset.batch_ID })
        .orderBy('createdAt asc');

      const documentAnchors = anchors.map((a: any) => ({
        documentHash: a.documentHash,
        documentType: a.documentType,
        visibility: a.visibility,
        txHash: a.onChainTxHash,
        status: a.status
      }));

      return {
        fingerprint: asset.fingerprint,
        currentHolder: asset.currentHolder,
        step: asset.step,
        isValid: allConfirmed && !anyFailed,
        onChainMatch: allVerified,
        steps,
        documentAnchors
      };
    });

    // -----------------------------------------------------------------------
    // Background polling — periodically check SUBMITTED transactions
    // -----------------------------------------------------------------------
    this._startPolling();

    return super.init();
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Post-confirmation side effects: update OnChainAssets and Batch status.
   */
  private async _onConfirmed(evt: any, txHash: string) {
    const { Batches, Participants, OnChainAssets, DocumentAnchors } = this.entities;

    if (evt.eventType === 'MINT') {
      const asset = await SELECT.one.from(OnChainAssets).where({ batch_ID: evt.batch_ID });
      if (asset) {
        await UPDATE(OnChainAssets)
          .set({ currentUtxoRef: txHash + '#0' })
          .where({ ID: asset.ID });
      }
      // Ensure manufacturer + currentHolder are set from minter's VKH
      const updateSet: any = { status: 'MINTED' };
      if (evt.signerVkh) {
        const minter = await SELECT.one.from(Participants)
          .where({ vkh: evt.signerVkh, isActive: true }).columns('ID');
        if (minter) {
          const batch = await SELECT.one.from(Batches).where({ ID: evt.batch_ID });
          if (!batch?.manufacturer_ID) updateSet.manufacturer_ID = minter.ID;
          if (!batch?.currentHolder_ID) updateSet.currentHolder_ID = minter.ID;
        }
      }
      await UPDATE(Batches).set(updateSet).where({ ID: evt.batch_ID });
    }

    if (evt.eventType === 'TRANSFER') {
      const asset = await SELECT.one.from(OnChainAssets).where({ batch_ID: evt.batch_ID });
      if (asset) {
        // Look up the new holder's VKH from the batch's currentHolder (set optimistically during TransferBatch)
        const batch = await SELECT.one.from(Batches).where({ ID: evt.batch_ID });
        const newHolder = batch?.currentHolder_ID
          ? await SELECT.one.from('trace.Participants').where({ ID: batch.currentHolder_ID })
          : null;

        await UPDATE(OnChainAssets)
          .set({
            currentUtxoRef: txHash + '#0',
            step: (asset.step ?? 0) + 1,
            currentHolder: newHolder?.vkh ?? evt.signerVkh
          })
          .where({ ID: asset.ID });
      }
      await UPDATE(Batches)
        .set({ status: 'IN_TRANSIT' })
        .where({ ID: evt.batch_ID });
    }

    if (evt.eventType === 'DOCUMENT_ANCHOR' && evt.buildId) {
      await UPDATE(DocumentAnchors)
        .set({ onChainTxHash: txHash, status: 'CONFIRMED' })
        .where({ buildId: evt.buildId });
    }
  }

  /**
   * Start periodic polling for SUBMITTED transactions.
   * Runs directly against the DB to avoid service-entity resolution issues
   * when called outside a request context.
   */
  private _startPolling() {
    const poll = async () => {
      try {
        const db = await cds.connect.to('db');
        const { ProofEvents, OnChainAssets, Batches, Participants, DocumentAnchors } = cds.entities('trace');

        const submitted = await db.run(SELECT.from(ProofEvents).where({ status: 'SUBMITTED' }));
        if (!submitted.length) return;

        let confirmed = 0, failed = 0;

        for (const evt of submitted) {
          if (!evt.submissionId) continue;

          const check = await chainAdapter.checkSubmissionStatus(evt.submissionId);
          const now = new Date().toISOString();

          if (check.status === 'confirmed') {
            await db.run(UPDATE(ProofEvents)
              .set({ status: 'CONFIRMED', onChainTxHash: check.txHash ?? evt.onChainTxHash, lastCheckedAt: now })
              .where({ ID: evt.ID }));

            // Post-confirmation side effects
            const txHash = check.txHash ?? evt.onChainTxHash;
            if (evt.eventType === 'MINT') {
              await db.run(UPDATE(OnChainAssets).set({ currentUtxoRef: txHash + '#0' }).where({ batch_ID: evt.batch_ID }));
              const mintUpdate: any = { status: 'MINTED' };
              if (evt.signerVkh) {
                const minter = await db.run(SELECT.one.from(Participants).where({ vkh: evt.signerVkh, isActive: true }));
                if (minter) {
                  const batch = await db.run(SELECT.one.from(Batches).where({ ID: evt.batch_ID }));
                  if (!batch?.manufacturer_ID) mintUpdate.manufacturer_ID = minter.ID;
                  if (!batch?.currentHolder_ID) mintUpdate.currentHolder_ID = minter.ID;
                }
              }
              await db.run(UPDATE(Batches).set(mintUpdate).where({ ID: evt.batch_ID }));
            }
            if (evt.eventType === 'TRANSFER') {
              const asset = await db.run(SELECT.one.from(OnChainAssets).where({ batch_ID: evt.batch_ID }));
              if (asset) {
                const batch = await db.run(SELECT.one.from(Batches).where({ ID: evt.batch_ID }));
                const newHolder = batch?.currentHolder_ID
                  ? await db.run(SELECT.one.from(Participants).where({ ID: batch.currentHolder_ID }))
                  : null;
                await db.run(UPDATE(OnChainAssets).set({
                  currentUtxoRef: txHash + '#0',
                  step: (asset.step ?? 0) + 1,
                  currentHolder: newHolder?.vkh ?? evt.signerVkh
                }).where({ ID: asset.ID }));
              }
              await db.run(UPDATE(Batches).set({ status: 'IN_TRANSIT' }).where({ ID: evt.batch_ID }));
            }
            if (evt.eventType === 'DOCUMENT_ANCHOR' && evt.buildId) {
              await db.run(UPDATE(DocumentAnchors).set({ onChainTxHash: txHash, status: 'CONFIRMED' }).where({ buildId: evt.buildId }));
            }
            confirmed++;
          } else if (check.status === 'failed') {
            await db.run(UPDATE(ProofEvents)
              .set({ status: 'FAILED', errorMessage: check.errorMessage, lastCheckedAt: now })
              .where({ ID: evt.ID }));
            failed++;
          } else {
            await db.run(UPDATE(ProofEvents).set({ lastCheckedAt: now }).where({ ID: evt.ID }));
          }
        }

        LOG.info(`Polled ${submitted.length} submissions: ${confirmed} confirmed, ${failed} failed`);
      } catch (err: any) {
        LOG.warn('Polling error:', err.message);
      }
    };

    // Start after a short delay to let the server fully boot
    setTimeout(() => {
      LOG.info(`Starting tx confirmation polling (every ${POLL_INTERVAL_MS / 1000}s)`);
      setInterval(poll, POLL_INTERVAL_MS);
    }, 5000);
  }
}
