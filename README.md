![TRACE](assets/image.png)

# TRACE: Pharmaceutical Supply Chain Tracking on Cardano

![TESTS](https://img.shields.io/badge/tests-passing-brightgreen)
![ODATANO](https://img.shields.io/badge/%40odatano%2Fcore-v1.7.7-blue)

TRACE is an example SAP FIORI application for tracking pharmaceutical supply chains, built on [SAP CAP](https://cap.cloud.sap/) and [Cardano](https://cardano.org/). It provides tamper-proof chain-of-custody for drug batches from manufacturer to pharmacy, using NFTs as on-chain proof and CIP-30 browser wallets for signing.

Blockchain integration via [ODATANO](https://github.com/ODATANO/ODATANO), a CAP plugin exposing Cardano as OData V4 services.

## Features

- **Batch NFT Minting:** Manufacturer mints a unique NFT per drug batch with on-chain datum
- **Chain of Custody Transfers:** Each handoff (manufacturer > distributor > pharmacy) is a Plutus spend tx
- **Document Anchoring:** SHA-256 hashes of certificates and cold-chain telemetry anchored via CIP-20 metadata
- **Public Verification:** Anyone can verify a batch's full custody chain
- **Transaction Monitoring:** 30s background polling, automatic PENDING > CONFIRMED/FAILED transitions
- **Retry Mechanics:** Failed transactions can be rebuilt and resubmitted

## Quick Start

### Prerequisites

- Node.js >= 18
- npm >= 9
- A CIP-30 Cardano wallet (Nami, Eternl, Lace) on **preview** network

### Install & Run

```bash
git clone https://github.com/ODATANO/TRACE && cd TRACE
npm install
TX_BUILDERS=buildooor npx cds watch
```

`cds watch` auto-deploys the SQLite schema (TRACE + ODATANO plugin) on first start.

Open http://localhost:4004/trace/webapp/index.html

## Documentation

- [App Walkthrough](docs/APP_WALKTHROUGH.MD): Screenshots and feature explanations
- [Architecture](docs/ARCHITECTURE.md): Tech stack, data model, project structure
- [Smart Contract & API](docs/SMART_CONTRACT.md): Aiken validator, OData actions, signing flow
- [Configuration](docs/CONFIGURATION.md): Plugin config, seed data, scripts
