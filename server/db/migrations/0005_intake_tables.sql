CREATE TYPE block_kind AS ENUM ('paragraph', 'heading', 'scene_break');
CREATE TYPE time_mode AS ENUM ('linear', 'flashback', 'skip', 'loop');

CREATE TABLE blocks (
    id text PRIMARY KEY DEFAULT ('blk_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
    version_id text NOT NULL REFERENCES chapter_versions (id) ON DELETE RESTRICT,
    block_uid text NOT NULL CHECK (block_uid ~ '^b_[0-9a-f]{12}$'),
    ordinal integer NOT NULL CHECK (ordinal >= 1),
    kind block_kind NOT NULL,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000000),
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    UNIQUE (version_id, ordinal),
    UNIQUE (version_id, block_uid)
);

CREATE INDEX blocks_block_uid_idx ON blocks (block_uid);

CREATE TABLE scenes (
    id text PRIMARY KEY DEFAULT ('scn_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
    version_id text NOT NULL REFERENCES chapter_versions (id) ON DELETE RESTRICT,
    ordinal integer NOT NULL CHECK (ordinal >= 1),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    first_block integer NOT NULL CHECK (first_block >= 1),
    last_block integer NOT NULL CHECK (last_block >= 1) CHECK (last_block >= first_block),
    pov_hint text CHECK (char_length(pov_hint) BETWEEN 1 AND 200),
    location_hint text CHECK (char_length(location_hint) BETWEEN 1 AND 200),
    time_hint text CHECK (char_length(time_hint) BETWEEN 1 AND 200),
    time_mode time_mode NOT NULL DEFAULT 'linear',
    UNIQUE (version_id, ordinal),
    FOREIGN KEY (version_id, first_block) REFERENCES blocks (version_id, ordinal) ON DELETE RESTRICT,
    FOREIGN KEY (version_id, last_block) REFERENCES blocks (version_id, ordinal) ON DELETE RESTRICT
);

CREATE TRIGGER blocks_immutable
    BEFORE UPDATE OR DELETE ON blocks
    FOR EACH ROW EXECUTE FUNCTION axis_reject_change();

CREATE TRIGGER scenes_immutable
    BEFORE UPDATE OR DELETE ON scenes
    FOR EACH ROW EXECUTE FUNCTION axis_reject_change();
