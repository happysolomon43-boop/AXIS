import { Fragment, type Node } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import { canonicalParagraphUid } from "./model";

export function createParagraphIdentity(): { initialize(doc: Node): Node; plugin: Plugin } {
  const stored = new Set<string>(), issued = new Set<string>();
  let counter = 0, initialized = false;
  function allocate(count: number): string[] {
    if (count > Number.MAX_SAFE_INTEGER - counter) throw new Error("Paragraph identity exhausted");
    return Array.from({ length: count }, () => {
      const uid = "local_p_" + (++counter);
      issued.add(uid);
      return uid;
    });
  }
  function initialize(doc: Node): Node {
    if (initialized) throw new Error("Paragraph identity already initialized");
    initialized = true;
    const children: Node[] = [];
    doc.forEach(node => {
      if (node.type.name !== "paragraph") { children.push(node); return; }
      const uid = node.attrs.block_uid;
      if (canonicalParagraphUid(uid) && !stored.has(uid)) { stored.add(uid); children.push(node); }
      else children.push(node.type.create({ ...node.attrs, block_uid: allocate(1)[0] }, node.content, node.marks));
    });
    return doc.copy(Fragment.fromArray(children));
  }
  const plugin = new Plugin({
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some(t => t.docChanged)) return null;
      const candidates = new Map<string, number[]>(), repair = new Set<number>(), oldStarts = new Map<string, number>();
      oldState.doc.forEach((node, pos) => {
        if (node.type.name === "paragraph") oldStarts.set(node.attrs.block_uid, pos);
      });
      newState.doc.forEach((node, pos) => {
        if (node.type.name !== "paragraph") return;
        const uid = node.attrs.block_uid;
        if (!stored.has(uid) && !issued.has(uid)) { repair.add(pos); return; }
        const positions = candidates.get(uid);
        if (positions) positions.push(pos); else candidates.set(uid, [pos]);
      });
      for (const [uid, positions] of candidates) {
        if (positions.length < 2) continue;
        let mapped = oldStarts.get(uid);
        if (mapped !== undefined) for (const t of transactions) mapped = t.mapping.map(mapped, 1);
        const keep = mapped !== undefined && positions.includes(mapped) ? mapped : positions[0];
        for (const pos of positions) if (pos !== keep) repair.add(pos);
      }
      if (repair.size === 0) return null;
      const ids = allocate(repair.size), tr = newState.tr;
      let i = 0;
      newState.doc.forEach((node, pos) => {
        if (repair.has(pos)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, block_uid: ids[i++] });
      });
      // Markup replacements must not move the native operation's final selection.
      tr.setSelection(newState.selection.getBookmark().resolve(tr.doc));
      return tr;
    },
  });
  return { initialize, plugin };
}
