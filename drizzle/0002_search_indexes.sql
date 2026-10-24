-- Metadata-only search: full-text (prefix matching on normalized text) + trigram fallback.
-- Requires extension pg_trgm (created by src/db/migrate.ts before migrating).
CREATE INDEX IF NOT EXISTS resources_search_fts_idx ON resources USING gin (to_tsvector('simple', search_text));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS resources_search_trgm_idx ON resources USING gin (search_text gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS resource_aliases_norm_idx ON resource_aliases (alias_normalized);
