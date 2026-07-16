# Configuration & Scripts

## ODATANO Plugin Config

In `package.json`:

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
        "blockfrostApiKey": "<your-preview-key>"
      }
    }
  }
}
```

> **blockfrost-only:** koios is deliberately not configured — its tx-info path
> drops inline datums, which breaks Plutus spends on script UTxOs
> (ODATANO KNOWN_ISSUES #9). Re-add it only once that issue is fixed upstream.

## Seed Data

CSV files in `db/data/`:

| File | Contents |
|------|----------|
| `trace-Participants.csv` | 3 participants (manufacturer, distributor, pharmacy) |
| `trace-Batches.csv` | 2 draft batches (Aspirin, Ibuprofen) |

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start server (`cds-tsx serve` — TS impls need the tsx loader) |
| `npm run testnet:coldchain` | Cold-chain e2e against a live Preview backend (`scripts/testnet/coldchain-e2e.mjs`) |
| `npx cds watch` | Start dev server with live reload (auto-deploys schema) |
| `npx cds deploy --to sqlite` | Manually (re-)create the SQLite DB from CDS models + CSV seeds — also required once after upgrading `@odatano/core` to 1.10 (new `SigningRequests.signedTxCbor` column) |

> ODATANO's schema is registered automatically via its `cds-plugin.js`, so the prior
> `scripts/deploy-db.js` is no longer needed.
