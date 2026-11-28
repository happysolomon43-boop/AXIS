ALTER TABLE chapter_drafts
    ADD COLUMN paragraph_lineage jsonb NULL,
    ADD CONSTRAINT chapter_drafts_paragraph_lineage_shape CHECK (
        paragraph_lineage IS NULL OR (
            CASE
                WHEN jsonb_typeof(paragraph_lineage) = 'array'
                    THEN jsonb_array_length(paragraph_lineage) BETWEEN 1 AND 1000000
                ELSE false
            END AND editor_document IS NOT NULL
        )
    );
