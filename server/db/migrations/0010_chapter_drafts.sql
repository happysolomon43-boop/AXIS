CREATE TABLE chapter_drafts (
    chapter_id text PRIMARY KEY REFERENCES chapters(id) ON DELETE RESTRICT,
    base_version text NOT NULL,
    content text NOT NULL CHECK (char_length(content) <= 1000000),
    revision integer NOT NULL CHECK (revision >= 1),
    FOREIGN KEY (chapter_id, base_version) REFERENCES chapter_versions(chapter_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION axis_clear_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM chapter_drafts WHERE chapter_id = NEW.chapter_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER chapter_versions_clear_draft
AFTER INSERT ON chapter_versions
FOR EACH ROW EXECUTE FUNCTION axis_clear_draft();
