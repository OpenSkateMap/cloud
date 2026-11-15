-- Mirrors production: the API connects as a role that can read and write rows but owns nothing, so
-- anything that only works for a table owner (DDL, RLS without policies) fails locally and in CI too.
CREATE ROLE openskatemap_app LOGIN PASSWORD 'openskatemap_app';
GRANT pg_read_all_data, pg_write_all_data TO openskatemap_app;
