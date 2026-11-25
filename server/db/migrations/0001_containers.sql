CREATE TYPE book_status AS ENUM ('planned', 'drafting', 'complete', 'released');

CREATE TABLE series (
    id text PRIMARY KEY DEFAULT ('ser_' || left(replace(gen_random_uuid()::text, '-', ''), 12)),
    owner_id text NOT NULL CHECK (owner_id ~ '^usr_[a-z0-9]{2,32}$'),
    title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200),
    genre_rubric_id text,
    foundation jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(foundation) = 'object')
);

CREATE TABLE books (
    id text PRIMARY KEY DEFAULT ('bk_' || left(replace(gen_random_uuid()::text, '-', ''), 12)),
    series_id text NOT NULL REFERENCES series (id) ON DELETE RESTRICT,
    title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200),
    ordinal integer NOT NULL CHECK (ordinal >= 1),
    label text,
    status book_status NOT NULL DEFAULT 'drafting',
    author_id text NOT NULL CHECK (author_id ~ '^usr_[a-z0-9]{2,32}$'),
    language text NOT NULL DEFAULT 'English' CHECK (char_length(language) BETWEEN 1 AND 64)
);

CREATE INDEX books_series_id_idx ON books (series_id);
