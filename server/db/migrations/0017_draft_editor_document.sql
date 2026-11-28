ALTER TABLE chapter_drafts
    ADD COLUMN editor_document jsonb NULL,
    ADD CONSTRAINT chapter_drafts_editor_document_shape CHECK (
        CASE
            WHEN editor_document IS NULL THEN true
            WHEN jsonb_typeof(editor_document) = 'array' THEN jsonb_array_length(editor_document) BETWEEN 1 AND 1000000
            ELSE false
        END
    );
