import { expect, test } from "vitest";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history } from "prosemirror-history";
import pkgRaw from "../package.json?raw";
import lockRaw from "../package-lock.json?raw";
const pkg = JSON.parse(pkgRaw);

test("AXB-0037 AC1 mounts, edits, scrolls, focuses and destroys a ProseMirror view in jsdom", () => {
  const schema = new Schema({ nodes: {
    doc: { content: "block+" }, paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] }, text: {},
  } });
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView(host, { state: EditorState.create({ schema, plugins: [history()] }) });
  try {
    view.dispatch(view.state.tr.insertText("Hi", 1).scrollIntoView());
    view.focus();
    expect(view.state.doc.textContent).toBe("Hi");
  } finally { view.destroy(); host.remove(); }
});

test("AXB-0037 AC3 preserves the exact workspace dependencies and scripts", () => {
  expect(pkg.dependencies).toEqual({ react: "^18.3.1", "react-dom": "^18.3.1", "prosemirror-model": "^1.22.0", "prosemirror-state": "^1.4.3", "prosemirror-view": "^1.34.0", "prosemirror-commands": "^1.6.0", "prosemirror-history": "^1.4.1", "prosemirror-keymap": "^1.2.2", "prosemirror-transform": "1.12.7" });
  const lock = JSON.parse(lockRaw);
  expect(lock.packages[""].dependencies["prosemirror-transform"]).toBe("1.12.7");
  expect(lock.packages["node_modules/prosemirror-transform"].version).toBe("1.12.7");
  expect(Object.keys(lock.packages).filter(path => path.endsWith("/prosemirror-transform"))).toEqual(["node_modules/prosemirror-transform"]);
  expect(pkg.devDependencies).toEqual({ "@testing-library/dom": "^10.4.0", "@testing-library/jest-dom": "^6.4.0", "@testing-library/react": "^16.0.0", "@testing-library/user-event": "^14.5.0", "@types/react": "^18.3.0", "@types/react-dom": "^18.3.0", "@vitejs/plugin-react": "^4.3.0", jsdom: "^24.1.0", typescript: "^5.4.0", vite: "^5.4.0", vitest: "^2.0.0" });
  expect(pkg.scripts).toEqual({ dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview", test: "vitest run", typecheck: "tsc --noEmit" });
});
