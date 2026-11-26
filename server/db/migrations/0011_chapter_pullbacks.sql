CREATE TABLE chapter_pullbacks (
    chapter_id text PRIMARY KEY REFERENCES chapters(id) ON DELETE RESTRICT,
    book_version text NOT NULL,
    FOREIGN KEY (chapter_id, book_version) REFERENCES chapter_versions(chapter_id, id) ON DELETE RESTRICT
);
