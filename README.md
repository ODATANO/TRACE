# TRACE — Pharmaceutical Supply Chain tracking on Cardano

TRACE is Example SAP FIORI Application for a pharmaceutical supply chain tracking system built on [SAP CAP](https://cap.cloud.sap/) and the [Cardano](https://cardano.org/) blockchain. It provides tamper-proof chain-of-custody for drug batches from manufacturer to pharmacy, using NFTs as on-chain proof and CIP-30 browser wallets for transaction signing.

**Blockchain integration via [ODATANO](https://github.com/ODATANO/ODATANO)** — a CAP plugin that exposes Cardano as OData V4 services. TRACE never calls Blockfrost/Koios directly.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│  ┌──────────────┐  ┌──────────────┐                     │
│  │ SAPUI5 App   │  │ CIP-30       │                     │
│  │ (Fiori UX)   │──│ Wallet       │ (Nami/Eternl/Lace)  │
│  └──────┬───────┘  └──────┬───────┘                     │
└─────────┼─────────────────┼─────────────────────────────┘
          │ OData V4        │ signTx(cbor)
┌─────────┼─────────────────┼─────────────────────────────┐
│  SAP CAP Server           │                             │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌───────────────┐  │
│  │ TraceService │──│ ChainAdapter │──│ ODATANO Plugin│  │
│  │ (8 actions)  │  │              │  │               │  │
│  └──────┬───────┘  └──────────────┘  └───────┬───────┘  │
│         │                                    │          │
│  ┌──────┴───────┐                    ┌───────┴───────┐  │
│  │ SQLite DB    │                    │    Cardano    │  │
│  │ (5 entities) │                    │    Preview    │  │
│  └──────────────┘                    └───────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Smart Contracts** | Aiken (Plutus V3) |
| **Blockchain** | Cardano preview testnet |
| **Chain Gateway** | @odatano/core v0.3.17 (CAP plugin) |
| **Backend** | SAP CAP v9, Node.js, TypeScript |
| **Database** | SQLite (dev), SAP HANA (prod) |
| **Frontend** | Freestyle SAPUI5 (OpenUI5 CDN, sap_horizon theme) |
| **Signing** | CIP-30 browser wallets (external signing, zero key custody) |

## Features

- **Batch NFT Minting** — Manufacturer mints a unique NFT per drug batch with on-chain datum
- **Chain of Custody Transfers** — Each handoff (manufacturer → distributor → pharmacy) is a Plutus spend transaction
- **Document Anchoring** — SHA-256 hashes of certificates, lab reports, and cold-chain telemetry anchored via CIP-20 metadata transactions
- **Public Verification** — Anyone can verify a batch's full custody chain against on-chain data
- **Transaction Monitoring** — 30-second background polling with automatic PENDING → CONFIRMED/FAILED transitions
- **Retry Mechanics** — Failed transactions can be rebuilt and resubmitted

## Quick Start

### Prerequisites

- Node.js >= 18
- npm >= 9
- A CIP-30 compatible Cardano wallet (Nami, Eternl, or Lace) set to **preview** network

### Install & Deploy

```bash
git clone <repo-url> && cd TRACE
npm install
npm run deploy       # Creates SQLite DB with all tables + seed data
```

### Run

```bash
TX_BUILDERS=buildooor npx cds watch
```

Open http://localhost:4004/trace/webapp/index.html

### Seed Data

Sample data is loaded from CSV files in `db/data/`:

| File | Contents |
|------|----------|
| `trace-Participants.csv` | 3 participants (manufacturer, distributor, pharmacy) |
| `trace-Batches.csv` | 2 draft batches (Aspirin, Ibuprofen) |

## Project Structure

```
TRACE/
├── db/
│   ├── schema.cds                  # 5 entities: Participants, Batches, OnChainAssets,
│   │                               #   ProofEvents, DocumentAnchors
│   └── data/                       # CSV seed data
├── srv/
│   ├── trace-service.cds           # OData V4 service definition (8 actions + 1 function)
│   ├── trace-service.ts            # Full handler implementation
│   └── lib/
│       ├── chain-adapter.ts        # ODATANO service wrapper (cds.connect.to)
│       └── digest.ts               # SHA-256 + JSON canonicalization
├── contracts/
│   ├── validators/
│   │   └── pharma_trace.ak         # Aiken smart contract (mint + spend + else)
│   └── plutus.json                 # Compiled Plutus V3 validators
├── app/
│   └── trace/webapp/               # SAPUI5 frontend
│       ├── index.html              # UI5 CDN bootstrap
│       ├── manifest.json           # App descriptor + OData V4 datasource
│       ├── Component.js            # Router (4 routes)
│       ├── model/
│       │   ├── CardanoWallet.js    # CIP-30 wallet integration
│       │   └── models.js           # JSONModel factories
│       ├── controller/             # App, BatchList, BatchDetail,
│       │                           #   Participants, Verify
│       ├── view/                   # XML views for each page
│       └── fragment/               # WalletConnect, TransferDialog,
│                                   #   AnchorDialog
├── scripts/
│   ├── deploy-db.js                # Full DB deployment (TRACE + ODATANO tables)
│   └── seed-protocol-params.js     # Cache Cardano protocol parameters
└── package.json                    # CAP config + ODATANO plugin config
```

## Data Model

```
Participants (Manufacturer | Distributor | Pharmacy | Regulator)
     │
     ├──< Batches (DRAFT → MINTED → IN_TRANSIT → DELIVERED | RECALLED)
     │      │
     │      ├──< OnChainAssets   1:1  (policyId, assetName, UTxO ref, step)
     │      ├──< ProofEvents     1:N  (MINT, TRANSFER, VERIFY, DOCUMENT_ANCHOR)
     │      └──< DocumentAnchors 1:N  (doc hash, type, cold-chain temps)
```

## Smart Contract

The Aiken validator (`contracts/validators/pharma_trace.ak`) enforces two rules on-chain:

**Mint policy** — Only the manufacturer (parameterized VKH) can mint, and exactly 1 token per transaction.

**Spend validator** — Transfers require:
1. Current holder's signature
2. A continuing output with updated datum (`current_holder = next_holder`, `step + 1`)

```
Datum: ChainOfCustody { manufacturer, current_holder, batch_id, step }
Redeemer: Action::Transfer { next_holder }
```

## OData Actions

| Action | Description |
|--------|-------------|
| `MintBatchNft(batchId)` | Build unsigned mint transaction |
| `TransferBatch(batchId, toParticipantId, ...)` | Build unsigned transfer transaction |
| `SubmitSigned(buildId, signedTxCbor)` | Submit externally signed transaction |
| `CheckPendingTransactions()` | Poll all SUBMITTED events for confirmation |
| `RetryFailedTransaction(proofEventId)` | Rebuild a failed transaction |
| `AnchorDocument(batchId, documentHash, ...)` | Anchor document hash on-chain |
| `AnchorColdChain(batchId, telemetryHash, ...)` | Anchor cold-chain telemetry |
| `VerifyBatch(batchIdOrFingerprint)` | Public chain-of-custody verification |

## Transaction Signing Flow

```
1. User clicks action (e.g. "Mint NFT")
2. App calls OData action        → { unsignedCbor, buildId }
3. App calls wallet.signTx(cbor) → browser wallet popup
4. User confirms in wallet        → signedCbor
5. App calls SubmitSigned         → { txHash, status: "SUBMITTED" }
6. Background polling (30s)       → status: "CONFIRMED" | "FAILED"
```

TRACE/ODATANO never hold private keys. All signing happens in the user's browser wallet.

## UI Pages

| Page | Description |
|------|-------------|
| **Batches** | List all batches with status chips, create new DRAFT batches |
| **Batch Detail** | Actions (Mint/Transfer/Anchor), event timeline, on-chain asset info |
| **Participants** | Inline CRUD table for supply chain participants |
| **Verify** | Public verification of batch custody chain |

## Configuration

ODATANO plugin config in `package.json`:

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "sqlite",
        "credentials": { "url": "db.sqlite" }
      },
      "odatano-core": {
        "network": "preview",
        "backends": ["blockfrost"],
        "blockfrostApiKey": "<your-preview-key>",
        "txBuilders": ["buildooor"]
      }
    }
  }
}
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run deploy` | Create/recreate SQLite DB with all tables + seed data |
| `npm start` | Start production server (`cds-serve`) |
| `npx cds watch` | Start dev server with live reload |

