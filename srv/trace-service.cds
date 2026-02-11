using { trace } from '../db/schema';

service TraceService @(path: '/odata/v4/trace') {

  entity Participants as projection on trace.Participants;
  entity Batches       as projection on trace.Batches;
  entity ProofEvents   as projection on trace.ProofEvents;
  entity OnChainAssets as projection on trace.OnChainAssets;
  entity DocumentAnchors as projection on trace.DocumentAnchors;

  // --- Domain Actions ---

  // Mint a batch NFT on Cardano (manufacturer only)
  action MintBatchNft(batchId : UUID, walletAddress : String, walletVkh : String) returns {
    policyId         : String;
    assetName        : String;
    fingerprint      : String;
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
  };

  // Transfer batch custody to the next participant
  action TransferBatch(
    batchId         : UUID,
    toParticipantId : UUID,
    transferReason  : String,
    transferNotes   : String,
    walletAddress   : String,
    walletVkh       : String
  ) returns {
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
  };

  // Submit an externally signed transaction (CIP-30 witness set or full signed tx)
  action SubmitSigned(
    signingRequestId : String,
    signedTxCbor     : LargeString
  ) returns {
    txHash       : String;
    submissionId : String;
    status       : String;
  };

  // Poll ODATANO for confirmation of all SUBMITTED transactions
  action CheckPendingTransactions() returns {
    checked   : Integer;
    confirmed : Integer;
    failed    : Integer;
  };

  // Retry a failed transaction (rebuilds + resubmits)
  action RetryFailedTransaction(proofEventId : UUID, walletAddress : String, walletVkh : String) returns {
    buildId          : String;
    signingRequestId : String;
    unsignedCbor     : LargeString;
    txBodyHash       : String;
  };

  // Anchor a document hash on-chain for a batch
  action AnchorDocument(
    batchId      : UUID,
    documentHash : String,
    documentType : String,
    visibility   : String,
    walletAddress : String,
    walletVkh     : String
  ) returns {
    buildId          : String;
    signingRequestId : String;
    unsignedCbor     : LargeString;
    txBodyHash       : String;
  };

  // Recall a batch — creates on-chain proof with reason (pharma compliance)
  action RecallBatch(
    batchId       : UUID,
    reason        : String,
    walletAddress : String,
    walletVkh     : String
  ) returns {
    buildId          : String;
    signingRequestId : String;
    unsignedCbor     : LargeString;
    txBodyHash       : String;
  };

  // Confirm receipt of a batch (marks as DELIVERED — business state only, no on-chain tx)
  action ConfirmReceipt(batchId : UUID) returns {
    status : String;
  };

  // Verify batch chain of custody (public, read-only)
  function VerifyBatch(batchIdOrFingerprint : String) returns {
    fingerprint   : String;
    currentHolder : String;
    step          : Integer;
    isValid       : Boolean;
    onChainMatch  : Boolean;
    steps         : array of {
      step          : Integer;
      holder        : String;
      eventType     : String;
      txHash        : String;
      status        : String;
      onChainStatus : String;
    };
    documentAnchors : array of {
      documentHash  : String;
      documentType  : String;
      visibility    : String;
      txHash        : String;
      status        : String;
    };
  };
}
