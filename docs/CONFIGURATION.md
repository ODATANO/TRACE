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
| `npm run deploy` | Create/recreate SQLite DB with tables + seed data |
| `npm start` | Start production server (`cds-serve`) |
| `npx cds watch` | Start dev server with live reload |
