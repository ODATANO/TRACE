import cds from '@sap/cds';
import * as chainAdapter from './lib/chain-adapter';
import { computeDigest } from './lib/digest';

const LOG = cds.log('trace');
const POLL_INTERVAL_MS = (cds.env.requires as any)?.['trace-service']?.pollIntervalMs ?? 30_000;

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

      // Allow retry: only block if asset is confirmed on-chain (has UTxO ref)
      const existingAsset = await SELECT.one.from(OnChainAssets).where({ batch_ID: batchId });
      if (existingAsset && existingAsset.currentUtxoRef) {
        return req.reject(409, `Batch already has a confirmed on-chain asset`);
      }

      // Clean up stale data from failed/cancelled previous attempt
      if (existingAsset) {
        await DELETE.from(OnChainAssets).where({ batch_ID: batchId });
        // Mark old PENDING mint events as FAILED
        await UPDATE(ProofEvents)
          .set({ status: 'FAILED', errorMessage: 'Superseded by retry' })
          .where({ batch_ID: batchId, eventType: 'MINT', status: 'PENDING' });
        // Reset batch status back to DRAFT for the retry
        await UPDATE(Batches).set({ status: 'DRAFT' }).where({ ID: batchId });
      }

      if (batch.status !== 'DRAFT' && !existingAsset) {
        return req.reject(409, `Batch status must be DRAFT, is ${batch.status}`);
      }

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
        scriptAddress: result.scriptAddress || null,
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
        targetParticipantId: toParticipantId,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        status: 'PENDING'
      });

      // Holder update deferred to SubmitSigned (after user signs)

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
          // Now that user has signed, update holder (deferred from TransferBatch)
          if (pendingEvent.targetParticipantId) {
            await UPDATE(Batches)
              .set({ currentHolder_ID: pendingEvent.targetParticipantId })
              .where({ ID: pendingEvent.batch_ID });
            const target = await SELECT.one.from(Participants).where({ ID: pendingEvent.targetParticipantId });
            if (target) {
              await UPDATE(OnChainAssets)
                .set({ currentHolder: target.vkh })
                .where({ batch_ID: pendingEvent.batch_ID });
            }
          }
        }
        if (pendingEvent.eventType === 'DELIVER') {
          await UPDATE(Batches).set({ status: 'DELIVERED' }).where({ ID: pendingEvent.batch_ID });
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

      // Also update any Participant registration linked to this signingRequestId
      const pendingRegistration = await SELECT.one.from(Participants)
        .where({ registrationSigningRequestId: signingRequestId, registrationStatus: 'PENDING' });
      if (pendingRegistration) {
        await UPDATE(Participants)
          .set({
            registrationTxHash: result.txHash,
            registrationSubmissionId: result.submissionId,
            registrationStatus: 'SUBMITTED'
          })
          .where({ ID: pendingRegistration.ID });
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

      // Also check SUBMITTED registrations
      const submittedRegistrations = await SELECT.from(Participants)
        .where({ registrationStatus: 'SUBMITTED' });

      for (const reg of submittedRegistrations) {
        if (!reg.registrationSubmissionId) continue;

        const check = await chainAdapter.checkSubmissionStatus(reg.registrationSubmissionId);
        const now = new Date().toISOString();

        if (check.status === 'confirmed') {
          await UPDATE(Participants)
            .set({
              registrationStatus: 'CONFIRMED',
              registrationTxHash: check.txHash ?? reg.registrationTxHash,
              registeredAt: now
            })
            .where({ ID: reg.ID });
          confirmed++;
        } else if (check.status === 'failed') {
          await UPDATE(Participants)
            .set({
              registrationStatus: 'FAILED',
              registrationErrorMessage: check.errorMessage
            })
            .where({ ID: reg.ID });
          failed++;
        }
      }

      const totalChecked = submitted.length + submittedRegistrations.length;
      LOG.info(`Checked ${totalChecked} submissions: ${confirmed} confirmed, ${failed} failed`);
      return { checked: totalChecked, confirmed, failed };
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
        if (!evt.targetParticipantId) return req.reject(409, `Transfer event missing target participant`);

        const target = await SELECT.one.from(Participants).where({ ID: evt.targetParticipantId });
        if (!target?.vkh) return req.reject(409, `Target participant not found for retry`);

        const [scriptTxHash, indexStr] = asset.currentUtxoRef.split('#');

        const result = await chainAdapter.transferBatch({
          senderAddress: walletAddress,
          manufacturerVkh: asset.manufacturerVkh,
          currentHolderVkh: walletVkh,
          nextHolderVkh: target.vkh,
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

      if (evt.eventType === 'DELIVER') {
        const asset = await SELECT.one.from(OnChainAssets).where({ batch_ID: batch.ID });
        if (!asset?.currentUtxoRef) return req.reject(409, `No current UTxO reference for retry`);
        if (!asset.manufacturerVkh) return req.reject(409, `On-chain asset missing manufacturerVkh`);

        const [scriptTxHash, indexStr] = asset.currentUtxoRef.split('#');

        const result = await chainAdapter.deliverBatch({
          senderAddress: walletAddress,
          manufacturerVkh: asset.manufacturerVkh,
          currentHolderVkh: walletVkh,
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

      // Deterministic digest: same inputs → same hash (no timestamp)
      const recallDigest = computeDigest({ reason, batchId, recalledBy: walletVkh });

      const result = await chainAdapter.anchorDocument({
        senderAddress: walletAddress,
        documentHash: recallDigest,
        metadataJson: JSON.stringify(metadata)
      });

      const signingReq = await chainAdapter.createSigningRequest(result.buildId);

      await INSERT.into(ProofEvents).entries({
        batch_ID: batchId,
        eventType: 'RECALL',
        payloadDigest: recallDigest,
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
    // ConfirmReceipt — on-chain delivery: NFT leaves script → holder wallet
    // -----------------------------------------------------------------------
    this.on('ConfirmReceipt', async (req) => {
      const { batchId, walletAddress, walletVkh } =
        req.data as { batchId: string; walletAddress: string; walletVkh: string };

      if (!walletAddress || !walletVkh) return req.reject(400, `Wallet address and VKH are required (connect wallet first)`);

      const batch = await SELECT.one.from(Batches).where({ ID: batchId });
      if (!batch) return req.reject(404, `Batch ${batchId} not found`);
      if (batch.status !== 'IN_TRANSIT') return req.reject(409, `Batch must be IN_TRANSIT to confirm delivery, is ${batch.status}`);

      const asset = await SELECT.one.from(OnChainAssets).where({ batch_ID: batchId });
      if (!asset) return req.reject(409, `No on-chain asset found for batch`);
      if (!asset.currentUtxoRef) return req.reject(409, `No current UTxO reference — last transfer not yet confirmed`);
      if (!asset.manufacturerVkh) return req.reject(409, `On-chain asset missing manufacturerVkh`);

      // Ownership check: wallet VKH must match on-chain current holder
      if (asset.currentHolder && asset.currentHolder !== walletVkh) {
        return req.reject(403, `Only the current holder can deliver this batch`);
      }

      const [scriptTxHash, indexStr] = asset.currentUtxoRef.split('#');
      const scriptOutputIndex = parseInt(indexStr, 10);

      const result = await chainAdapter.deliverBatch({
        senderAddress: walletAddress,
        manufacturerVkh: asset.manufacturerVkh,
        currentHolderVkh: walletVkh,
        batchIdHex: chainAdapter.toHex(batch.batchNumber),
        currentStep: asset.step,
        scriptTxHash,
        scriptOutputIndex
      });

      // Create signing request for CIP-30 wallet flow
      const signingReq = await chainAdapter.createSigningRequest(result.buildId);

      const digest = computeDigest({
        action: 'DELIVER',
        timestamp: new Date().toISOString()
      });

      await INSERT.into(ProofEvents).entries({
        batch_ID: batchId,
        eventType: 'DELIVER',
        payloadDigest: digest,
        schema: 'TRACE_DELIVER_V1',
        signerVkh: walletVkh,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        status: 'PENDING'
      });

      return {
        unsignedCbor: signingReq.unsignedTxCbor,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        txBodyHash: signingReq.txBodyHash
      };
    });

    // -----------------------------------------------------------------------
    // RegisterParticipant — self-service registration via on-chain NFT mint
    // -----------------------------------------------------------------------
    this.on('RegisterParticipant', async (req) => {
      const { name, role, walletAddress, walletVkh } =
        req.data as { name: string; role: string; walletAddress: string; walletVkh: string };

      if (!walletAddress || !walletVkh) return req.reject(400, 'Wallet address and VKH are required (connect wallet first)');
      if (!name) return req.reject(400, 'Participant name is required');
      if (!role) return req.reject(400, 'Participant role is required');

      // Check if VKH is already registered
      const existing = await SELECT.one.from(Participants).where({ vkh: walletVkh });
      if (existing) {
        if (existing.registrationStatus === 'CONFIRMED' || existing.registrationStatus === 'SUBMITTED') {
          return req.reject(409, 'A participant with this wallet VKH already exists');
        }
        // PENDING or FAILED — allow re-registration by rebuilding the transaction
        const result = await chainAdapter.mintRegistrationNft({
          senderAddress: walletAddress,
          registrantVkh: walletVkh
        });

        const signingReq = await chainAdapter.createSigningRequest(result.buildId);

        await UPDATE(Participants).set({
          name,
          role,
          address: walletAddress,
          registrationStatus: 'PENDING',
          registrationPolicyId: result.policyId,
          registrationBuildId: result.buildId,
          registrationSigningRequestId: signingReq.signingRequestId,
          registrationSubmissionId: null,
          registrationTxHash: null,
          registrationErrorMessage: null
        }).where({ ID: existing.ID });

        return {
          participantId: existing.ID,
          policyId: result.policyId,
          unsignedCbor: signingReq.unsignedTxCbor,
          buildId: result.buildId,
          signingRequestId: signingReq.signingRequestId,
          txBodyHash: signingReq.txBodyHash
        };
      }

      // New registration
      const result = await chainAdapter.mintRegistrationNft({
        senderAddress: walletAddress,
        registrantVkh: walletVkh
      });

      const signingReq = await chainAdapter.createSigningRequest(result.buildId);

      const participantId = cds.utils.uuid();
      await INSERT.into(Participants).entries({
        ID: participantId,
        name,
        role,
        address: walletAddress,
        vkh: walletVkh,
        isActive: true,
        registrationStatus: 'PENDING',
        registrationPolicyId: result.policyId,
        registrationBuildId: result.buildId,
        registrationSigningRequestId: signingReq.signingRequestId
      });

      return {
        participantId,
        policyId: result.policyId,
        unsignedCbor: signingReq.unsignedTxCbor,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        txBodyHash: signingReq.txBodyHash
      };
    });

    // -----------------------------------------------------------------------
    // AddParticipant — add a participant on behalf, mint registration NFT to their wallet
    // -----------------------------------------------------------------------
    this.on('AddParticipant', async (req) => {
      const { name, role, participantAddress, participantVkh, walletAddress, walletVkh } =
        req.data as { name: string; role: string; participantAddress: string; participantVkh: string; walletAddress: string; walletVkh: string };

      if (!walletAddress || !walletVkh) return req.reject(400, 'Wallet address and VKH are required (connect wallet first)');
      if (!name) return req.reject(400, 'Participant name is required');
      if (!role) return req.reject(400, 'Participant role is required');
      if (!participantAddress) return req.reject(400, 'Participant Cardano address is required');
      if (!participantVkh) return req.reject(400, 'Participant VKH is required');

      // Check if VKH is already registered
      const existing = await SELECT.one.from(Participants).where({ vkh: participantVkh });
      if (existing) {
        if (existing.registrationStatus === 'CONFIRMED' || existing.registrationStatus === 'SUBMITTED') {
          return req.reject(409, 'A participant with this address already exists');
        }
        // PENDING or FAILED — allow re-add
        const result = await chainAdapter.mintRegistrationNftFor({
          senderAddress: walletAddress,
          senderVkh: walletVkh,
          recipientAddress: participantAddress
        });

        const signingReq = await chainAdapter.createSigningRequest(result.buildId);

        await UPDATE(Participants).set({
          name,
          role,
          address: participantAddress,
          registrationStatus: 'PENDING',
          registrationPolicyId: result.policyId,
          registrationBuildId: result.buildId,
          registrationSigningRequestId: signingReq.signingRequestId,
          registrationSubmissionId: null,
          registrationTxHash: null,
          registrationErrorMessage: null
        }).where({ ID: existing.ID });

        return {
          participantId: existing.ID,
          policyId: result.policyId,
          unsignedCbor: signingReq.unsignedTxCbor,
          buildId: result.buildId,
          signingRequestId: signingReq.signingRequestId,
          txBodyHash: signingReq.txBodyHash
        };
      }

      // New participant
      const result = await chainAdapter.mintRegistrationNftFor({
        senderAddress: walletAddress,
        senderVkh: walletVkh,
        recipientAddress: participantAddress
      });

      const signingReq = await chainAdapter.createSigningRequest(result.buildId);

      const participantId = cds.utils.uuid();
      await INSERT.into(Participants).entries({
        ID: participantId,
        name,
        role,
        address: participantAddress,
        vkh: participantVkh,
        isActive: true,
        registrationStatus: 'PENDING',
        registrationPolicyId: result.policyId,
        registrationBuildId: result.buildId,
        registrationSigningRequestId: signingReq.signingRequestId
      });

      return {
        participantId,
        policyId: result.policyId,
        unsignedCbor: signingReq.unsignedTxCbor,
        buildId: result.buildId,
        signingRequestId: signingReq.signingRequestId,
        txBodyHash: signingReq.txBodyHash
      };
    });

    // -----------------------------------------------------------------------
    // ResolveWallet — resolve connected wallet to participant (DB + on-chain)
    // -----------------------------------------------------------------------
    this.on('ResolveWallet', async (req) => {
      const { walletAddress, walletVkh } =
        req.data as { walletAddress: string; walletVkh: string };

      if (!walletAddress || !walletVkh) return req.reject(400, 'Wallet address and VKH are required');

      // 1. DB lookup — fast path
      const existing = await SELECT.one.from(Participants)
        .where({ vkh: walletVkh, isActive: true });

      if (existing) {
        LOG.info(`ResolveWallet: found participant ${existing.ID} (${existing.name}) in DB`);
        return { participantId: existing.ID, participantName: existing.name, source: 'db' };
      }

      // 2. On-chain check — look for REGISTRATION NFT in wallet
      const REGISTRATION_HEX = '524547495354524154494f4e'; // toHex('REGISTRATION')
      try {
        const assets = await chainAdapter.getWalletAssets(walletAddress);
        LOG.info(`ResolveWallet: got ${(assets || []).length} assets for ${walletAddress}`);

        // Match via multiple strategies:
        // - unit field = policyId(56) + assetNameHex → endsWith check
        // - asset_assetName or asset.assetName may contain hex or UTF-8
        // - asset_assetNameHex or asset.assetNameHex (if populated)
        const regAsset = (assets || []).find((a: any) => {
          if (a.unit && a.unit.endsWith(REGISTRATION_HEX)) return true;
          if (a.asset_assetNameHex === REGISTRATION_HEX) return true;
          if (a.asset?.assetNameHex === REGISTRATION_HEX) return true;
          if (a.asset_assetName === REGISTRATION_HEX) return true;
          if (a.asset?.assetName === REGISTRATION_HEX) return true;
          if (a.asset_assetName === 'REGISTRATION') return true;
          if (a.asset?.assetName === 'REGISTRATION') return true;
          return false;
        });

        if (!regAsset) {
          LOG.info('ResolveWallet: no REGISTRATION NFT found in wallet assets');
          return { participantId: null, participantName: null, source: 'none' };
        }

        // 3. Found registration NFT — auto-create participant
        const policyId = regAsset.asset_policyId || regAsset.asset?.policyId || '';
        LOG.info(`ResolveWallet: found REGISTRATION NFT (policyId: ${policyId}, unit: ${regAsset.unit})`);
        const participantId = cds.utils.uuid();
        const now = new Date().toISOString();

        await INSERT.into(Participants).entries({
          ID: participantId,
          name: 'Wallet holder',
          role: 'Manufacturer',
          address: walletAddress,
          vkh: walletVkh,
          isActive: true,
          registrationStatus: 'CONFIRMED',
          registrationPolicyId: policyId,
          registeredAt: now
        });

        LOG.info(`Auto-created participant ${participantId} from on-chain registration NFT (policyId: ${policyId})`);
        return { participantId, participantName: 'Wallet holder', source: 'on-chain' };

      } catch (err: any) {
        LOG.warn('On-chain asset check failed:', err.message);
        // Fall back to no match — don't block login
        return { participantId: null, participantName: null, source: 'none' };
      }
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

    // Clean up polling interval on shutdown
    cds.on('shutdown', () => {
      if (this._pollingInterval) {
        clearInterval(this._pollingInterval);
        this._pollingInterval = null;
        LOG.info('Polling interval cleared');
      }
    });

    return super.init();
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Shared post-confirmation side effects.
   * @param run - query executor: identity for request context, db.run for polling context
   */
  private async _applyConfirmationSideEffects(
    evt: any, txHash: string,
    run: (q: any) => Promise<any> = (q) => q
  ) {
    const { Batches, Participants, OnChainAssets, DocumentAnchors } = cds.entities('trace');

    if (evt.eventType === 'MINT') {
      const asset = await run(SELECT.one.from(OnChainAssets).where({ batch_ID: evt.batch_ID }));
      if (asset) {
        const outputIdx = asset.scriptAddress
          ? await chainAdapter.getScriptOutputIndex(txHash, asset.scriptAddress)
          : 0;
        await run(UPDATE(OnChainAssets)
          .set({ currentUtxoRef: txHash + '#' + outputIdx })
          .where({ ID: asset.ID }));
      }
      const updateSet: any = { status: 'MINTED' };
      if (evt.signerVkh) {
        const minter = await run(SELECT.one.from(Participants)
          .where({ vkh: evt.signerVkh, isActive: true }));
        if (minter) {
          const batch = await run(SELECT.one.from(Batches).where({ ID: evt.batch_ID }));
          if (!batch?.manufacturer_ID) updateSet.manufacturer_ID = minter.ID;
          if (!batch?.currentHolder_ID) updateSet.currentHolder_ID = minter.ID;
        }
      }
      await run(UPDATE(Batches).set(updateSet).where({ ID: evt.batch_ID }));
    }

    if (evt.eventType === 'TRANSFER') {
      const asset = await run(SELECT.one.from(OnChainAssets).where({ batch_ID: evt.batch_ID }));
      if (asset) {
        const outputIdx = asset.scriptAddress
          ? await chainAdapter.getScriptOutputIndex(txHash, asset.scriptAddress)
          : 0;
        // Use targetParticipantId (stored during TransferBatch) for the new holder
        let newHolderVkh = evt.signerVkh;
        if (evt.targetParticipantId) {
          const target = await run(SELECT.one.from(Participants).where({ ID: evt.targetParticipantId }));
          if (target?.vkh) newHolderVkh = target.vkh;
        }
        await run(UPDATE(OnChainAssets).set({
          currentUtxoRef: txHash + '#' + outputIdx,
          step: (asset.step ?? 0) + 1,
          currentHolder: newHolderVkh
        }).where({ ID: asset.ID }));
      }
      await run(UPDATE(Batches).set({ status: 'IN_TRANSIT' }).where({ ID: evt.batch_ID }));
    }

    if (evt.eventType === 'DELIVER') {
      const asset = await run(SELECT.one.from(OnChainAssets).where({ batch_ID: evt.batch_ID }));
      if (asset) {
        await run(UPDATE(OnChainAssets).set({
          currentUtxoRef: null,
          step: (asset.step ?? 0) + 1
        }).where({ ID: asset.ID }));
      }
      await run(UPDATE(Batches).set({ status: 'DELIVERED' }).where({ ID: evt.batch_ID }));
    }

    if (evt.eventType === 'DOCUMENT_ANCHOR' && evt.buildId) {
      await run(UPDATE(DocumentAnchors)
        .set({ onChainTxHash: txHash, status: 'CONFIRMED' })
        .where({ buildId: evt.buildId }));
    }
  }

  /**
   * Post-confirmation hook called from SubmitSigned (within request context).
   */
  private async _onConfirmed(evt: any, txHash: string) {
    await this._applyConfirmationSideEffects(evt, txHash);
  }

  /**
   * Start periodic polling for SUBMITTED transactions.
   */
  private _pollingInterval: ReturnType<typeof setInterval> | null = null;

  private _startPolling() {
    // Prevent duplicate polling on hot-reload
    if (this._pollingInterval) {
      clearInterval(this._pollingInterval);
      this._pollingInterval = null;
    }

    const poll = async () => {
      try {
        const db = await cds.connect.to('db');
        const { ProofEvents } = cds.entities('trace');
        const run = db.run.bind(db);

        // Check both SUBMITTED and FAILED events that have a txHash (may have been confirmed on-chain)
        const submitted = await run(
          SELECT.from(ProofEvents).where('status in', ['SUBMITTED', 'FAILED']).and('onChainTxHash is not null')
        );
        if (!submitted.length) return;

        let confirmed = 0, failed = 0;

        for (const evt of submitted) {
          const now = new Date().toISOString();

          // Strategy 1: Check via ODATANO submission tracking
          if (evt.submissionId) {
            const check = await chainAdapter.checkSubmissionStatus(evt.submissionId);

            if (check.status === 'confirmed') {
              const txHash = check.txHash ?? evt.onChainTxHash;
              await run(UPDATE(ProofEvents)
                .set({ status: 'CONFIRMED', onChainTxHash: txHash, lastCheckedAt: now })
                .where({ ID: evt.ID }));
              await this._applyConfirmationSideEffects(evt, txHash, run);
              confirmed++;
              continue;
            }

            // For 'failed', 'submitted', or 'unknown' — fall through to on-chain check
          }

          // Strategy 2: Verify directly on-chain if we have a txHash
          if (evt.onChainTxHash) {
            const onChain = await chainAdapter.isTxConfirmedOnChain(evt.onChainTxHash);
            if (onChain) {
              await run(UPDATE(ProofEvents)
                .set({ status: 'CONFIRMED', lastCheckedAt: now })
                .where({ ID: evt.ID }));
              await this._applyConfirmationSideEffects(evt, evt.onChainTxHash, run);
              confirmed++;
              continue;
            }
          }

          // Neither ODATANO nor on-chain confirmed — leave as SUBMITTED for now
          await run(UPDATE(ProofEvents).set({ lastCheckedAt: now }).where({ ID: evt.ID }));
        }

        // Also check SUBMITTED registrations
        const { Participants: PollingParticipants } = cds.entities('trace');
        const submittedRegs = await run(
          SELECT.from(PollingParticipants).where('registrationStatus in', ['SUBMITTED', 'FAILED'])
        );
        for (const reg of submittedRegs) {
          const now = new Date().toISOString();

          // Strategy 1: ODATANO submission tracking
          if (reg.registrationSubmissionId) {
            const check = await chainAdapter.checkSubmissionStatus(reg.registrationSubmissionId);
            if (check.status === 'confirmed') {
              await run(UPDATE(PollingParticipants).set({
                registrationStatus: 'CONFIRMED',
                registrationTxHash: check.txHash ?? reg.registrationTxHash,
                registeredAt: now
              }).where({ ID: reg.ID }));
              confirmed++;
              continue;
            }
          }

          // Strategy 2: Direct on-chain check via txHash
          if (reg.registrationTxHash) {
            const onChain = await chainAdapter.isTxConfirmedOnChain(reg.registrationTxHash);
            if (onChain) {
              await run(UPDATE(PollingParticipants).set({
                registrationStatus: 'CONFIRMED',
                registeredAt: now
              }).where({ ID: reg.ID }));
              confirmed++;
              continue;
            }
          }
        }

        LOG.info(`Polled ${submitted.length + submittedRegs.length} submissions: ${confirmed} confirmed, ${failed} failed`);
      } catch (err: any) {
        LOG.warn('Polling error:', err.message);
      }
    };

    // Start after a short delay to let the server fully boot
    setTimeout(() => {
      LOG.info(`Starting tx confirmation polling (every ${POLL_INTERVAL_MS / 1000}s)`);
      this._pollingInterval = setInterval(poll, POLL_INTERVAL_MS);
    }, 5000);
  }
}
