-- PostgreSQL does not recognize \v as an escape in E-strings; E'\v' is the
-- literal letter v. The original function therefore rejected canonical text
-- ending in v. Spell every ECMAScript trim code point explicitly.
CREATE OR REPLACE FUNCTION "normalized_text_is_canonical"(
  "value" TEXT,
  "maximum_length" INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT "maximum_length" >= 1
    AND "value" <> ''
    AND "value" = btrim(
      "value",
      chr(32)
        || chr(9)
        || chr(10)
        || chr(13)
        || chr(12)
        || chr(11)
        || chr(160)
        || chr(5760)
        || chr(8192)
        || chr(8193)
        || chr(8194)
        || chr(8195)
        || chr(8196)
        || chr(8197)
        || chr(8198)
        || chr(8199)
        || chr(8200)
        || chr(8201)
        || chr(8202)
        || chr(8232)
        || chr(8233)
        || chr(8239)
        || chr(8287)
        || chr(12288)
        || chr(65279)
    )
    AND char_length("value") <= "maximum_length"
$$;
