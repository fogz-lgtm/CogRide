# Route data attribution

- **Road geometry** (`geometry/*.json`, used for the road's bends and the
  GPS track of real climbs): Overture Maps Foundation transportation data,
  derived from OpenStreetMap. © OpenStreetMap contributors, available under
  the Open Database License (ODbL) — https://www.openstreetmap.org/copyright.
  These files are a derived database and are likewise offered under the ODbL.
- **Elevation** used to fit the gradient tables in `catalog.json`: AWS Terrain
  Tiles (Mapzen), including USGS 3DEP, EU-DEM (Copernicus) and SRTM.
- Gradient tables were fitted at 500 m and cross-checked against published
  length, gain and landmark elevations; sources per route are in
  `catalog.json`. The four loops (Fogline Coast, Cathedral Redwoods,
  Glasswater Lakes, Juniper Mesa) are fictional.
