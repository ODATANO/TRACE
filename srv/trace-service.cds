using {trace} from '../db/schema';

service TraceService @(path: '/odata/v4/trace', impl: './trace-service') {

  entity Participants         as projection on trace.Participants;
  entity Batches              as projection on trace.Batches;
  entity ProofEvents          as projection on trace.ProofEvents;
  entity OnChainAssets        as projection on trace.OnChainAssets;
  entity DocumentAnchors      as projection on trace.DocumentAnchors;
  entity ManufacturerCounters as projection on trace.ManufacturerCounters;
  entity ConditionMonitors    as projection on trace.ConditionMonitors {
    *,
    // Fiori criticality (1=Negative/red, 2=Critical, 3=Positive/green).
    case when breached then 1 else 3 end             as breachCriticality : Integer,
    case status
      when 'CONFIRMED' then 3
      when 'FAILED'    then 1
      when 'CLOSED'    then 0
      else 2
    end                                              as statusCriticality : Integer
  };
  entity ConditionReadings    as projection on trace.ConditionReadings {
    *,
    case when withinSpec then 3 else 1 end           as specCriticality : Integer
  };

  // --- Domain Actions ---

  // Bootstrap the per-manufacturer counter NFT (one-shot). Must run once before minting any batches.
  action   InitManufacturerCounter(walletAddress: String, walletVkh: String) returns {
    counterId        : UUID;
    policyId         : String;
    scriptAddress    : String;
    seedTxHash       : String;
    seedIdx          : Integer;
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
  };

  // Mint a batch NFT on Cardano (manufacturer only)
  action   MintBatchNft(batchId: UUID, walletAddress: String, walletVkh: String)                returns {
    policyId         : String;
    assetName        : String;
    fingerprint      : String;
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
  };

  // Transfer batch custody to the next participant
  action   TransferBatch(batchId: UUID,
                         toParticipantId: UUID,
                         transferReason: String,
                         transferNotes: String,
                         walletAddress: String,
                         walletVkh: String)                                                     returns {
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
  };

  // Submit an externally signed transaction (CIP-30 witness set or full signed tx)
  action   SubmitSigned(signingRequestId: String,
                        signedTxCbor: LargeString)                                              returns {
    txHash       : String;
    submissionId : String;
    status       : String;
  };

  // Poll ODATANO for confirmation of all SUBMITTED transactions
  action   CheckPendingTransactions()                                                           returns {
    checked   : Integer;
    confirmed : Integer;
    failed    : Integer;
  };

  // Retry a failed transaction (rebuilds + resubmits)
  action   RetryFailedTransaction(proofEventId: UUID, walletAddress: String, walletVkh: String) returns {
    buildId          : String;
    signingRequestId : String;
    unsignedCbor     : LargeString;
    txBodyHash       : String;
  };

  // Anchor a document hash on-chain for a batch
  action   AnchorDocument(batchId: UUID,
                          documentHash: String,
                          documentType: String,
                          visibility: String,
                          walletAddress: String,
                          walletVkh: String)                                                    returns {
    buildId          : String;
    signingRequestId : String;
    unsignedCbor     : LargeString;
    txBodyHash       : String;
  };

  // Recall a batch — creates on-chain proof with reason (pharma compliance)
  action   RecallBatch(batchId: UUID,
                       reason: String,
                       walletAddress: String,
                       walletVkh: String)                                                       returns {
    buildId          : String;
    signingRequestId : String;
    unsignedCbor     : LargeString;
    txBodyHash       : String;
  };

  // Confirm delivery on-chain — NFT leaves script address, batch becomes non-transferable
  action   ConfirmReceipt(batchId: UUID,
                          walletAddress: String,
                          walletVkh: String)                                                    returns {
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
  };

  // Register a new participant via on-chain NFT mint (self-service)
  action   RegisterParticipant(name: String,
                               role: String,
                               walletAddress: String,
                               walletVkh: String)                                               returns {
    participantId    : UUID;
    policyId         : String;
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
  };

  // Add a participant on behalf (current user mints registration NFT to their wallet)
  action   AddParticipant(name: String,
                          role: String,
                          participantAddress: String,
                          participantVkh: String,
                          walletAddress: String,
                          walletVkh: String)                                                    returns {
    participantId    : UUID;
    policyId         : String;
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
  };

  // Resolve connected wallet to a participant (checks DB + on-chain assets)
  action   ResolveWallet(walletAddress: String,
                         walletVkh: String)                                                     returns {
    participantId   : UUID;
    participantName : String;
    source          : String;
  };

  // --- Cold-chain condition monitoring ---

  // Bootstrap a cold-chain monitor thread for a batch (one-shot NFT mint).
  // The connected wallet acts as the oracle. minMilliC/maxMilliC = spec range
  // in signed milli-degrees Celsius (e.g. 2..8 C -> 2000..8000).
  action   InitColdChainMonitor(batchId: UUID,
                                minMilliC: Integer,
                                maxMilliC: Integer,
                                walletAddress: String,
                                walletVkh: String)                                              returns {
    monitorId        : UUID;
    policyId         : String;
    scriptAddress    : String;
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
  };

  // Commit a batch of off-chain sensor readings to a monitor thread.
  // readingsJson = JSON array of { metric?, milliValue, recordedAt }.
  action   RecordSensorReadings(monitorId: UUID,
                                readingsJson: LargeString,
                                walletAddress: String,
                                walletVkh: String)                                              returns {
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
    newReadingCount  : Integer;
    newBreachCount   : Integer;
    breached         : Boolean;
  };

  // Finalise a monitor thread (NFT leaves the script; no further readings).
  action   CloseColdChainMonitor(monitorId: UUID,
                                 walletAddress: String,
                                 walletVkh: String)                                             returns {
    unsignedCbor     : LargeString;
    buildId          : String;
    signingRequestId : String;
    txBodyHash       : String;
  };

  // Verify batch chain of custody (public, read-only)
  function VerifyBatch(batchIdOrFingerprint: String)                                            returns {
    fingerprint     : String;
    currentHolder   : String;
    step            : Integer;
    isValid         : Boolean;
    onChainMatch    : Boolean;
    steps           : array of {
      step          : Integer;
      holder        : String;
      eventType     : String;
      txHash        : String;
      status        : String;
      onChainStatus : String;
    };
    documentAnchors : array of {
      documentHash : String;
      documentType : String;
      visibility   : String;
      txHash       : String;
      status       : String;
    };
    // Cold-chain integrity summary (aggregated across the batch's monitors).
    coldChain       : {
      monitored    : Boolean;   // at least one monitor exists for this batch
      breached     : Boolean;   // any monitor recorded a spec excursion
      monitorCount : Integer;
      readingCount : Integer;   // total committed readings across monitors
      breachCount  : Integer;   // total out-of-spec readings
      minMilliC    : Integer;   // spec range (from the first monitor)
      maxMilliC    : Integer;
    };
  };
}
