-- Spot search (GET /v1/spots/search): trigram indexes and similarity, accent folding, typo distance.
-- PlanetScale Postgres allows all three without superuser or a restart.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;--> statement-breakpoint

-- What search compares. pg_trgm sees only the letters the database's LC_CTYPE knows (none of Cyrillic under C), so
-- Cyrillic is romanised (a common Russian and Ukrainian scheme: ё as e, й as `short_i`); then lowercase, no accents,
-- and anything but letters and digits as one space. pg_c_utf8 is built in: Unicode case and letter classes whatever
-- the database's collation. IMMUTABLE although unaccent() is STABLE (its rules only change with the extension), so a
-- generated column can use it; that also keeps Postgres from inlining it.
CREATE FUNCTION "search_fold"(value text, short_i text DEFAULT 'i') RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN btrim(regexp_replace(
  lower(unaccent('unaccent', translate(
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      lower(normalize(value, NFC) COLLATE "pg_c_utf8"),
      'й', short_i), 'щ', 'shch'), 'ж', 'zh'), 'х', 'kh'), 'ц', 'ts'), 'ч', 'ch'), 'ш', 'sh'), 'ю', 'yu'), 'я', 'ya'), 'ї', 'yi'), 'є', 'ye'),
    -- translate() drops the letters past the end of its replacement: ь and ъ.
    'абвгдеёзиклмнопрстуфыэіґўьъ', 'abvgdeeziklmnoprstufyeigu'
  )) COLLATE "pg_c_utf8") COLLATE "pg_c_utf8",
  '[^[:alnum:]]+', ' ', 'g'
));--> statement-breakpoint

-- The words a name is found by: with й as и (how queries are folded), and as y when the name has one.
CREATE FUNCTION "search_words"(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN CASE WHEN search_fold(value, 'y') = search_fold(value) THEN search_fold(value) ELSE search_fold(value) || ' ' || search_fold(value, 'y') END;
