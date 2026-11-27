import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Binder } from "../src/binder/Binder";
import { reply } from "./d06.fixtures";
import { bookC, chaptersPath, deferred, mockApi, type Call } from "./helpers";
import { internalEnvelope } from "./historyFixtures";
import { notInBookEnvelope, pbList, pbListAfterB, pbListAfterC, pbTree, pullBackReplyB } from "./pullbackFixtures";

const [, b, c] = pbList.chapters;
const pathB = `/api/chapters/${b.id}/pull-back`;
const pathC = `/api/chapters/${c.id}/pull-back`;
const failureText = "The chapter could not be pulled back.";
const names = ["Pull back Chapter 2", "Pull back Chapter 3: The Third Bell"];
const routes = (calls: Call[]) => calls.map(({ method, path }) => `${method} ${path}`);
const listGet = `GET ${chaptersPath}`;
const part = (node: ParentNode, name: string) => node.querySelector(`[data-part="${name}"]`);
const buttonB = () => screen.getByRole("button", { name: names[0] });
const buttonC = () => screen.getByRole("button", { name: names[1] });
const ready = () => screen.findByRole("button", { name: names[0] });

test("AXB-0072 AC1 offers the action on the two eligible rows and respects the Draft lock", async () => {
  const secondBook = { ...pbTree, books: [...pbTree.books, bookC] };
  const secondBookPath = `/api/books/${bookC.id}/chapters`;
  const anotherChapter = { ...b, id: "ch_00000000000f", book_id: bookC.id, title: "The Next Book" };
  const post = deferred<typeof pullBackReplyB>();
  const { calls } = mockApi([
    { method: "GET", path: chaptersPath, reply: (_, n) => reply(n === 0 ? pbList : pbListAfterB) },
    { method: "GET", path: secondBookPath, reply: reply({ chapters: [anotherChapter] }) },
    { method: "POST", path: pathB, reply: () => post.promise },
  ]);
  const { rerender } = render(<Binder tree={secondBook} />);
  await ready();
  const buttons = screen.getAllByRole("button", { name: /^Pull back Chapter/ });
  expect(buttons).toHaveLength(2);
  buttons.forEach((button, n) => {
    const row = button.parentElement!;
    expect(button).toHaveAccessibleName(names[n]);
    expect(button).toHaveTextContent(/^Pull back$/);
    expect(button).toHaveAttribute("type", "button");
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAttribute("disabled");
    expect(button.nextElementSibling).toBe(row.lastElementChild);
    expect(button.nextElementSibling).toBe(part(row, "chapter-open"));
  });

  rerender(<Binder tree={secondBook} locked />);
  for (const button of buttons) {
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("disabled");
    fireEvent.click(button);
  }
  expect(routes(calls)).toEqual([listGet]);

  rerender(<Binder tree={secondBook} />);
  fireEvent.click(screen.getByRole("button", { name: bookC.title }));
  const other = await screen.findByRole("button", { name: "Pull back Chapter 1: The Next Book" });
  fireEvent.click(buttonB());
  expect(other).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(other);
  expect(routes(calls)).toEqual([listGet, `GET ${secondBookPath}`, `POST ${pathB}`]);
  await act(async () => { post.resolve(pullBackReplyB); });
  expect(other).not.toHaveAttribute("aria-disabled");
});

test("AXB-0072 AC2 starts one POST and one silent read, opens once and restores focus when already open", async () => {
  for (const openChapterId of [null, b.id]) {
    const post = deferred<typeof pullBackReplyB>();
    const settle = deferred<ReturnType<typeof reply>>();
    const onOpenChapter = vi.fn();
    const { calls } = mockApi([
      { method: "GET", path: chaptersPath, reply: (_, n) => n === 0 ? reply(pbList) : n === 1 ? settle.promise : reply(pbList) },
      { method: "POST", path: pathB, reply: () => post.promise },
    ]);
    const { container, unmount } = render(<Binder tree={pbTree} openChapterId={openChapterId} onOpenChapter={onOpenChapter} />);
    const button = await ready();
    const openButton = button.nextElementSibling;
    button.focus();
    fireEvent.click(button);
    expect(button).toHaveTextContent(/^Pulling back\.\.\.$/);
    expect(button).toHaveFocus();
    for (const action of [button, buttonC()]) {
      expect(action).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(action);
    }
    expect(routes(calls)).toEqual([listGet, `POST ${pathB}`]);
    expect(calls[1].body).toEqual({expected_active_version_id:b.active_version_id});

    await act(async () => { post.resolve(pullBackReplyB); });
    expect(routes(calls)).toEqual([listGet, `POST ${pathB}`, listGet]);
    expect(buttonC()).toHaveAttribute("aria-disabled", "true");
    expect(part(container, "reading")).toBeNull();
    expect(onOpenChapter.mock.calls).toEqual(openChapterId === null ? [[b.id]] : []);

    await act(async () => { settle.resolve(reply(pbListAfterB)); });
    expect(within(openButton!.parentElement!).getByText("Being revised, no changes yet")).toBeInTheDocument();
    expect(button).not.toBeInTheDocument();
    expect(buttonC()).not.toHaveAttribute("aria-disabled");
    expect(part(container, "pull-back-failure")).toBeNull();
    expect(onOpenChapter.mock.calls).toEqual(openChapterId === null ? [[b.id]] : []);
    if (openChapterId === b.id) expect(openButton).toHaveFocus();
    else expect(openButton).not.toHaveFocus();
    expect(routes(calls)).toEqual([listGet, `POST ${pathB}`, listGet]);
    unmount();
  }
});

test("AXB-0072 AC3 settles errors once, discovers a landed write and allows manual retry", async () => {
  const settleReplies = [
    { post: internalEnvelope, read: reply(pbList), landed: false },
    { post: "network" as const, read: reply(pbListAfterC), landed: true },
    { post: internalEnvelope, read: internalEnvelope, landed: false },
    { post: notInBookEnvelope, read: reply({ chapters: pbList.chapters.map((item) => item.id === c.id
      ? { ...item, active_version_id: null, sync: { state: "draft_only", same: false } } : item) }), landed: false },
  ];
  for (const { post, read, landed } of settleReplies) {
    const settle = deferred<ReturnType<typeof reply>>();
    const onOpenChapter = vi.fn();
    const { calls } = mockApi([
      { method: "GET", path: chaptersPath, reply: (_, n) => n === 0 ? reply(pbList) : n === 1 ? settle.promise : reply(pbList) },
      { method: "POST", path: pathC, reply: post },
    ]);
    const { container, unmount } = render(<Binder tree={pbTree} onOpenChapter={onOpenChapter} />);
    await ready();
    const active = buttonC();
    const row = active.parentElement!;
    active.focus();
    fireEvent.click(active);
    const message = await screen.findByRole("status");
    expect(message).toHaveAttribute("data-part", "pull-back-failure");
    expect(message).toHaveTextContent(failureText);
    expect(message.previousElementSibling).toBe(part(container, "chapter-list"));
    expect(active).toHaveAttribute("aria-disabled", "true");

    await act(async () => { settle.resolve(read); });
    expect(routes(calls)).toEqual([listGet, `POST ${pathC}`, listGet]);
    if(read===internalEnvelope){
      expect(buttonB()).toHaveAttribute("aria-disabled","true");
      expect(active).toHaveAttribute("aria-disabled","true");
      fireEvent.click(screen.getByRole("button",{name:"Check again"}));
      await waitFor(()=>expect(buttonB()).not.toHaveAttribute("aria-disabled"));
      expect(routes(calls)).toEqual([listGet,`POST ${pathC}`,listGet,listGet]);
      expect(onOpenChapter).not.toHaveBeenCalled();
      unmount();continue;
    }
    expect(buttonB()).not.toHaveAttribute("aria-disabled");
    if (landed) {
      expect(message).not.toBeInTheDocument();
      expect(onOpenChapter.mock.calls).toEqual([[c.id]]);
      expect(part(row, "chip")).toHaveTextContent(/^Being revised$/);
      expect(active).not.toBeInTheDocument();
      expect(part(row, "chapter-open")).not.toHaveFocus();
    } else {
      expect(message).toBeInTheDocument();
      expect(onOpenChapter).not.toHaveBeenCalled();
      if (post === notInBookEnvelope) {
        expect(active).not.toBeInTheDocument();
        expect(part(row, "chapter-open")).toHaveFocus();
      } else {
        expect(active).not.toHaveAttribute("aria-disabled");
        fireEvent.click(active);
        expect(message).not.toBeInTheDocument();
        await waitFor(() => expect(routes(calls).slice(0, 4)).toEqual([listGet, `POST ${pathC}`, listGet, `POST ${pathC}`]));
        await waitFor(() => expect(active).not.toHaveAttribute("aria-disabled"));
      }
    }
    unmount();
  }
});

test("AXB-0072 AC4 observes the latest lock and drops replies after collapse or unmount", async () => {
  for (const lateState of ["locked", "collapsed", "unmounted"]) {
    const post = deferred<typeof pullBackReplyB>();
    const onOpenChapter = vi.fn();
    const { calls } = mockApi([
      { method: "GET", path: chaptersPath, reply: (_, n) => reply(n === 0 ? pbList : pbListAfterB) },
      { method: "POST", path: pathB, reply: () => post.promise },
    ]);
    const { container, rerender, unmount } = render(<Binder tree={pbTree} onOpenChapter={onOpenChapter} />);
    const button = await ready();
    const row = button.parentElement!;
    fireEvent.click(button);
    if (lateState === "locked") rerender(<Binder tree={pbTree} locked onOpenChapter={onOpenChapter} />);
    if (lateState === "collapsed") fireEvent.click(part(container, "book-toggle")!);
    if (lateState === "unmounted") unmount();

    await act(async () => { post.resolve(pullBackReplyB); });
    expect(onOpenChapter).not.toHaveBeenCalled();
    if (lateState === "locked") {
      expect(part(row, "chip")).toHaveTextContent("Being revised, no changes yet");
      expect(routes(calls)).toEqual([listGet, `POST ${pathB}`, listGet]);
    } else {
      expect(routes(calls)).toEqual([listGet, `POST ${pathB}`]);
      if (lateState === "collapsed") {
        expect(button).toHaveTextContent(/^Pull back$/);
        expect(button).not.toHaveAttribute("aria-disabled");
      }
    }
    unmount();
  }
});
