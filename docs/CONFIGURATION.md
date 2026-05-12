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
        "backends": ["blockfrost", "koios"],
        "blockfrostApiKey": "<your-preview-key>",
        "txBuilders": ["buildooor"]
      }
    }
  }
}
```

## Seed Data

CSV files in `db/data/`:

| File | Contents |
|------|----------|
| `trace-Participants.csv` | 3 participants (manufacturer, distributor, pharmacy) |
| `trace-Batches.csv` | 2 draft batches (Aspirin, Ibuprofen) |

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start production server (`cds-serve`) |
| `npx cds watch` | Start dev server with live reload (auto-deploys schema) |
| `npx cds deploy --to sqlite` | Manually (re-)create the SQLite DB from CDS models + CSV seeds |

> ODATANO's schema is registered automatically via its `cds-plugin.js`, so the prior
> `scripts/deploy-db.js` is no longer needed.
