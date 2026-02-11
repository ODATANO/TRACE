namespace trace;

entity Participants {
  key ID        : UUID;
  name          : String(255);
  role          : String enum { Manufacturer; Distributor; Pharmacy; Regulator };
  address       : String(120); // Cardano bech32 address (for ODATANO tx building)
  vkh           : String(56);  // Cardano verification key hash (hex, 28 bytes)
  isActive      : Boolean default true;
}

entity Batches {
  key ID        : UUID;
  batchNumber   : String(100);
  product       : String(255);
  manufacturer  : Association to Participants;
  currentHolder : Association to Participants;
  status        : String enum { DRAFT; MINTED; IN_TRANSIT; DELIVERED; RECALLED };
  originPayload : LargeString;
  onChainAsset  : Composition of one OnChainAssets on onChainAsset.batch = $self;
  proofEvents   : Composition of many ProofEvents on proofEvents.batch = $self;
  documentAnchors : Composition of many DocumentAnchors on documentAnchors.batch = $self;
  createdAt     : Timestamp @cds.on.insert: $now;
  modifiedAt    : Timestamp @cds.on.insert: $now @cds.on.update: $now;
}

entity OnChainAssets {
  key ID           : UUID;
  batch            : Association to Batches;
  policyId         : String(56);
  assetName        : String(64);
  fingerprint      : String(44);  // CIP-14 asset fingerprint
  currentUtxoRef   : String(80);  // txHash#index
  datumHash        : String(64);
  step             : Integer default 0;
  manufacturerVkh  : String(56);  // vkh of original manufacturer (set at mint, never changes)
  currentHolder    : String(56);  // vkh of current holder
}

entity ProofEvents {
  key ID           : UUID;
  batch            : Association to Batches;
  eventType        : String enum { MINT; TRANSFER; VERIFY; RECALL; DOCUMENT_ANCHOR };
  payloadDigest    : String(64);  // SHA-256 hex
  schema           : String(100); // schema identifier
  signerVkh        : String(56);
  onChainTxHash    : String(64);
  status           : String enum { PENDING; SUBMITTED; CONFIRMED; FAILED } default 'PENDING';
  buildId          : String(36);  // ODATANO TransactionBuilds.id
  signingRequestId : String(36);  // ODATANO SigningRequests.id
  submissionId     : String(36);  // ODATANO TransactionSubmissions.id
  confirmations    : Integer default 0;
  errorMessage     : String(500);
  lastCheckedAt    : Timestamp;
  createdAt        : Timestamp @cds.on.insert: $now;
}

entity DocumentAnchors {
  key ID           : UUID;
  batch            : Association to Batches;
  documentHash     : String(64);  // SHA-256 of the document
  documentType     : String(100); // e.g. CERTIFICATE_OF_ANALYSIS
  visibility       : String enum { PUBLIC; HOLDER_ONLY; REGULATOR_ONLY };
  buildId          : String(36);  // ODATANO TransactionBuilds.id
  signingRequestId : String(36);  // ODATANO SigningRequests.id
  submissionId     : String(36);  // ODATANO TransactionSubmissions.id
  onChainTxHash    : String(64);
  status           : String enum { PENDING; SUBMITTED; CONFIRMED; FAILED } default 'PENDING';
  createdAt        : Timestamp @cds.on.insert: $now;
}
