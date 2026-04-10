# TRACE Application Walkthrough

TRACE is a pharmaceutical supply chain tracking application built on the Cardano blockchain. It uses NFTs and Plutus smart contracts to provide tamper-proof custody tracking from manufacturer to pharmacy. This document walks through the main screens and features.

---

## Getting Started

The welcome screen presents two ways to access the application. Supply chain participants connect a **Cardano wallet** (CIP-30 standard) to gain full access, the app auto-detects installed browser wallets such as Eternl, Lace, Nami, and others. Public users who only need to verify a batch can enter via **"Continue as Guest (Verify Only)"**, which provides read-only access to the verification page without requiring a wallet.

- **Wallet login**: Full access to Batches, Participants, and Verify
- **Guest login**: Verify tab only — no wallet required

![TRACE Login Screen](/assets/trace_login.png)

---

## Participants

The Participants page manages the supply chain members who can hold and transfer pharmaceutical batches. Each participant is identified by their **Cardano address** and **verification key hash (VKH)** a 28-byte cryptographic identifier derived from their wallet. Participants are assigned a role that reflects their position in the supply chain.

Registration is backed by an **on-chain NFT**: when a participant is added, a registration token is minted to their wallet, proving their identity on the blockchain. Only registered participants with an active status can send or receive batches.

- **Roles**: Manufacturer, Distributor, Pharmacy, Regulator
- **Add Participant**: Register a new supply chain member (mints a registration NFT)
- **Active toggle**: Enable or disable a participant
- **VKH**: Uniquely identifies the participant's wallet on-chain

![Participants View](/assets/parties.png)

---

## Batches

The Batches page shows pharmaceutical batches relevant to the connected wallet. The view is split into two tabs to keep focus on what matters:

- **My Batches**: Batches where the connected wallet is the manufacturer. Shows all lifecycle states.
- **Incoming**: Batches currently in transit to the connected wallet, awaiting confirmation.

Each batch moves through a defined lifecycle: **DRAFT** (created, not yet on-chain), **MINTED** (NFT created on Cardano), **IN_TRANSIT** (transferred to another participant), **DELIVERED** (final recipient confirmed), or **RECALLED** (pulled from the supply chain). Use **"Create Batch"** to start a new batch with product metadata, and search by batch number or product name.

![Batches View](/assets/batch_view.png)

---

## Transfer Batch Custody

Transferring a batch moves custody from the current holder to the next participant in the supply chain. The transfer dialog shows the batch details (batch number, product, current holder) and requires selecting a registered recipient.

Each transfer is an **on-chain Plutus spend transaction**: the NFT moves from the current script UTxO to a new one with an updated `ChainOfCustody` datum. The current holder's wallet must **sign the transaction** to authorize the transfer. A transfer reason and optional shipping notes are recorded as proof metadata.

- **Transfer to**: Select from registered participants
- **Reason**: Routine Distribution, Emergency Redistribution, Return, etc.
- **Shipping Notes**: Free-text field for logistics details
- **Transfer & Sign**: Builds the Plutus transaction and prompts the wallet for signing

![Transfer Batch Dialog](/assets/transfer.png)

---

## Deliver & Sign

The Batch Detail page provides a comprehensive view of a batch's on-chain history. The **Proof Events** tab shows every recorded event (MINT, TRANSFER, DELIVER) with its confirmation status, signer VKH, transaction hash, and timestamp. Transaction hashes link directly to Cardanoscan for independent verification.

When a batch arrives at its final destination, the recipient clicks **"Deliver & Sign"**. This triggers a confirmation dialog explaining that the delivery transaction moves the NFT from the script address to the recipient's wallet permanently. Once delivered, the batch is **no longer transferable** through the Plutus validator — the NFT in the wallet serves as a permanent delivery certificate.

- **Proof Events**: Full audit trail with on-chain transaction references
- **Confirm Delivery**: Moves the NFT to the holder's wallet (irreversible)
- **On-Chain Asset tab**: Shows policy ID, fingerprint, script address, and current UTxO
- **Documents tab**: Anchored documents (certificates, lab reports) with on-chain hashes

![Deliver & Sign](/assets/deliver_and_sign.png)

---

## Verify

The Verify page is publicly accessible so no wallet connection required (available via Guest login). It allows anyone to verify the authenticity and custody history of a pharmaceutical batch by entering its **CIP-14 asset fingerprint** (e.g., `asset1ycm23t...`) or batch ID.

The verification result includes a **Verification Summary** showing the on-chain validity status, the CIP-14 fingerprint, the current holder's VKH, and the custody step count. Below that, the **Chain of Custody** timeline displays every step in the batch's journey — from minting through each transfer to final delivery — with the holder's VKH and transaction hash at each step. Each event is independently verified against the Cardano blockchain, with the status shown as "verified", "pending", or "not_found".

- **Input**: CIP-14 fingerprint or batch ID
- **Verification Summary**: Valid/invalid, on-chain match, fingerprint, holder, custody step
- **Chain of Custody**: Step-by-step timeline (MINT, TRANSFER, DELIVER)
- **Transaction links**: Each tx hash links to Cardanoscan for independent audit
- **No wallet required**: Accessible to regulators, consumers, and auditors without blockchain tools

![Verify Batch](/assets/verify.png)
