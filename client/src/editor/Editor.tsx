import "prosemirror-view/style/prosemirror.css";
import "../styles/page.css";
import "./editor.css";
import { useLayoutEffect, useRef } from "react";
import type { Node } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { copy } from "../copy";
import { blocksToDoc, editorDocumentToDoc, type EditorBlock } from "./model";
import type { EditorDocument } from "../api/types";
import { createParagraphIdentity, ParagraphAllocationError, type DraftIdentityOptions } from "./paragraphIdentity";

type Props = {
  blocks: EditorBlock[];
  draftIdentity?: DraftIdentityOptions;
  restoredDocument?: EditorDocument | null;
  preparedIdentity?: ReturnType<typeof createParagraphIdentity>;
  preparedDocument?: Node;
  onIdentityFailure?: () => void;
  editable: boolean;
  onDocChange: (doc: Node) => void;
  onReady?: (view: EditorView) => void;
  onDispose?: (view: EditorView) => void;
};

export function Editor({ blocks, editable, onDocChange, onReady, onDispose, draftIdentity, restoredDocument, preparedIdentity, preparedDocument, onIdentityFailure }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initial = useRef(blocks);
  const callbacks = useRef({ onDocChange, onReady, onDispose, onIdentityFailure });
  callbacks.current = { onDocChange, onReady, onDispose, onIdentityFailure };
  const canEdit = useRef(editable);
  canEdit.current = editable;

  useLayoutEffect(() => {
    const identity = preparedIdentity ?? createParagraphIdentity(draftIdentity);
    const view = new EditorView(host.current!, {
      state: EditorState.create({
        doc: preparedDocument ?? identity.initialize(restoredDocument ? editorDocumentToDoc(restoredDocument) : blocksToDoc(initial.current)),
        plugins: [history(), keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo }), keymap(baseKeymap), identity.plugin],
      }),
      editable: () => canEdit.current,
      attributes: {
        "data-part": "editor", role: "textbox", "aria-multiline": "true",
        "aria-label": copy["editor.textLabel"], tabindex: "0", class: "ax-page",
      },
      dispatchTransaction(transaction) {
        if (transaction.docChanged && (!canEdit.current || !view.editable)) return;
        let applied: ReturnType<EditorState["applyTransaction"]>;
        try { applied = view.state.applyTransaction(transaction); }
        catch (error) {
          if (!(error instanceof ParagraphAllocationError)) throw error;
          callbacks.current.onIdentityFailure?.();
          return;
        }
        if (!applied.transactions.length) return;
        view.updateState(applied.state);
        if (applied.transactions.some(t => t.docChanged)) callbacks.current.onDocChange(applied.state.doc);
      },
    });
    viewRef.current = view;
    callbacks.current.onReady?.(view);
    return () => {
      viewRef.current = null;
      view.destroy();
      callbacks.current.onDispose?.(view);
    };
  }, []);

  useLayoutEffect(() => {
    viewRef.current?.setProps({ editable: () => editable });
  }, [editable]);

  return (
    <div className="ax-leaf" data-part="leaf" data-profile="literary" data-theme="light">
      <span className="ax-leaf-edge ax-leaf-edge--start" data-part="leaf-edge" aria-hidden="true" />
      <div data-part="editor-host" className="ax-column" ref={host} />
      <span className="ax-leaf-edge ax-leaf-edge--end" data-part="leaf-edge" aria-hidden="true" />
    </div>
  );
}
