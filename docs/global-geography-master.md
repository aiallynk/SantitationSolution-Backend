# Global Geography Master

The platform uses platform-owned rows (`geographies.tenant_id IS NULL`) as the canonical global master. This intentionally preserves the existing hierarchy, API compatibility, internal UUIDs, facility links, user scopes, Zones, Wards, QR records, and reports. Tenant-compatible copies link back through `global_geography_id`; the older `master_geography_id` remains populated for compatibility.

## Sources and attribution

- GeoNames downloadable gazetteer files provide the global hierarchy, populated places, aliases, coordinates, population, timezone, and daily modification/delete feeds. GeoNames data is UTF-8 tab-delimited and licensed under CC BY 4.0. Attribution: `GeoNames (https://www.geonames.org/)`.
- geoBoundaries `gbOpen` provides ADM0-ADM2 geometry and source-specific licence metadata. Preserve each response's `boundaryLicense`, `boundarySource`, source URL, build date, and source update date. Do not assume every boundary has the same upstream licence.
- Government of India Local Government Directory provides authoritative State, District, Sub-District, and validated Urban Local Body identities. LGD names/codes override Indian administrative display identity while GeoNames points and geoBoundaries geometry remain available as separate source references.
- Google Maps is not used by bulk imports. It remains available for manual verification, optional Place ID enrichment, and facility pins.

The Settings page displays attribution stored for active imported records.

## Setup

```bash
npm run db:migrate
npm run geography:download
npm run geography:bootstrap
npm run geography:link-existing
npm run geography:validate
npm run geography:report
```

`geography:bootstrap` is an explicit deployment operation and is never run at application startup. The default populated-place mode is `all`; set `GLOBAL_POPULATED_PLACE_MODE=cities500` or pass `--place-mode=cities500` for a smaller deployment. `administrative_seats` is also supported when staging an all-countries file.

To include boundary and India-authoritative enrichment in the same orchestration, pass local JSON manifests:

```powershell
npm run geography:bootstrap -- --boundaries-manifest=data/geography/boundaries.json --lgd-manifest=data/geography/lgd.json
```

`boundaries.json` is an array of `{ "file", "metadata", "iso3", "level", "version" }` entries. `lgd.json` is an array of `{ "file", "entity", "sourceModifiedAt", "version" }` entries. The equivalent environment variables are `GEOGRAPHY_BOUNDARY_MANIFEST` and `GEOGRAPHY_LGD_MANIFEST`. Missing manifests are reported as skipped; LGD files must be downloaded manually from its controlled official workflow.

Cached downloads are stored under `data/geography/` and ignored by Git. Use `--force` to replace a cached file. Each import batch records the source file, SHA-256 checksum, logical input scope, checkpoint, counters, status, and errors.

## India-first rollout

Use the scoped import before any worldwide place import:

```powershell
cd backend

npm run db:migrate

npm run geography:download -- --country=IN

npm run geography:bootstrap -- `
  --country=IN `
  --place-mode=cities500 `
  --boundaries-manifest=data/geography/boundaries/boundaries-india.json `
  --lgd-manifest=data/geography/lgd/lgd-india.json

npm run geography:link-existing -- --country=IN
npm run geography:validate -- --country=IN
npm run geography:report -- --country=IN
```

```bash
cd backend

npm run db:migrate

npm run geography:download -- --country=IN

npm run geography:bootstrap -- \
  --country=IN \
  --place-mode=cities500 \
  --boundaries-manifest=data/geography/boundaries/boundaries-india.json \
  --lgd-manifest=data/geography/lgd/lgd-india.json

npm run geography:link-existing -- --country=IN
npm run geography:validate -- --country=IN
npm run geography:report -- --country=IN
```

`--country=IN` and `--iso3=IND` are accepted for the India-safe scope. Country import reads `countryInfo.txt`; India `--place-mode=all` requires `IN.zip` and fails with a clear error when the file is missing. India `--place-mode=cities500` filters `cities500.zip` to Indian rows only. The importer never falls back to `allCountries.zip` for India populated-place import.

Expected local files:

```text
data/geography/
  geonames/
    countryInfo.txt
    IN.zip
    admin1CodesASCII.txt
    admin2Codes.txt
    alternateNamesV2.zip
    featureCodes.txt
    timeZones.txt
  boundaries/
    IND_ADM0.geojson
    IND_ADM0.metadata.json
    IND_ADM1.geojson
    IND_ADM1.metadata.json
    IND_ADM2.geojson
    IND_ADM2.metadata.json
    boundaries-india.json
  lgd/
    states.csv
    districts.csv
    urban-local-bodies.csv
    lgd-india.json
```

Boundary manifest example:

```json
[
  { "file": "data/geography/boundaries/IND_ADM0.geojson", "metadata": "data/geography/boundaries/IND_ADM0.metadata.json", "iso3": "IND", "level": "ADM0", "version": "current" },
  { "file": "data/geography/boundaries/IND_ADM1.geojson", "metadata": "data/geography/boundaries/IND_ADM1.metadata.json", "iso3": "IND", "level": "ADM1", "version": "current" },
  { "file": "data/geography/boundaries/IND_ADM2.geojson", "metadata": "data/geography/boundaries/IND_ADM2.metadata.json", "iso3": "IND", "level": "ADM2", "version": "current" }
]
```

LGD manifest example:

```json
[
  { "file": "data/geography/lgd/states.csv", "entity": "state", "sourceModifiedAt": "2026-07-20", "version": "india-initial" },
  { "file": "data/geography/lgd/districts.csv", "entity": "district", "sourceModifiedAt": "2026-07-20", "version": "india-initial" },
  { "file": "data/geography/lgd/urban-local-bodies.csv", "entity": "urban_local_body", "sourceModifiedAt": "2026-07-20", "version": "india-initial" }
]
```

Urban Local Bodies remain optional and can require review before becoming canonical city records. Missing LGD manifests are reported as skipped; the importer does not attempt LGD CAPTCHA or controlled-download automation. geoBoundaries downloads should be provided through the local manifest workflow.

## Individual operations

```bash
npm run geography:import:countries
npm run geography:import:admin
npm run geography:import:places
npm run geography:import:aliases
npm run geography:import:lgd -- --file=/secure/lgd/states.csv --entity=state
npm run geography:import:lgd -- --file=/secure/lgd/districts.csv --entity=district
npm run geography:import:boundaries -- --file=/secure/IND_ADM1.geojson --metadata=/secure/IND_ADM1.metadata.json --iso3=IND --level=ADM1
```

LGD downloads may require the official site's interactive controls. Download them through the authorized LGD workflow and provide the files to the importer; do not automate CAPTCHA bypass.

## Synchronization

Use a GeoNames modifications file as the `--file` input and optionally provide its matching deletes file:

```bash
npm run geography:sync -- --file=/secure/modifications-YYYY-MM-DD.txt --deletes=/secure/deletes-YYYY-MM-DD.txt
```

Updates use `source + externalCode`, preserve the global UUID, retain renamed names as aliases, and mark validated deletes inactive. Tenant assignments and referenced tenant geography IDs are never removed. Run boundary and LGD refreshes periodically with their individual commands.

## Safety and recovery

- Source rows are staged and validated before final upsert.
- Invalid coordinates and unresolved parents stay in staging with an explicit status.
- Ambiguous LGD or boundary matches are not auto-merged.
- Batches are resumable by their level/last-ID checkpoint.
- A repeated source checksum and input scope reuses the prior batch.
- Final rows are retired with `is_active = false`; they are never hard-deleted by synchronization.
- Tenant activation creates ancestry in one transaction and is protected by a unique tenant/global link.

Review `npm run geography:report` after every deployment import. A production rollout should import a small country fixture first, verify hierarchy counts and map bounds, then run the global batch during a controlled maintenance window.
