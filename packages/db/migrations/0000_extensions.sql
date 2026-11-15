-- PostGIS: spot locations are geometry(Point, 4326) with GiST indexes; city membership and duplicate checks
-- use ST_Contains / ST_DWithin. PlanetScale Postgres ships PostGIS 3.6.4; migrate.ts checks the version.
CREATE EXTENSION IF NOT EXISTS postgis;
