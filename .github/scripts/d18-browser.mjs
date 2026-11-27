import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { request, withPreview, writeGuard } from "./preview-smoke.mjs";

const { chromium } = await import(pathToFileURL(process.env.AXIS_BROWSER_MODULE).href);
const part = (scope, name) => scope.locator(`[data-part="${name}"]`);
const style = (element, property) => element.evaluate((node, key) => getComputedStyle(node).getPropertyValue(key), property);

function luminance(color) {
  const [r, g, b] = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
  return [r, g, b].map(n => color.startsWith("color(srgb") ? n : n / 255)
    .map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
    .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

await withPreview(async () => {
  const browser = await chromium.launch({
    headless: true, ...(process.env.AXIS_BROWSER_EXECUTABLE ? { executablePath: process.env.AXIS_BROWSER_EXECUTABLE } : {}),
  });
  try {
    for (const touch of [false, true]) {
      const tree = await request(1, "POST", "/series", 201, { title: "Binder acceptance" });
      const list = "/books/" + tree.books[0].id + "/chapters";
      const first = await request(2, "POST", list, 201, { content: "River." });
      const path = "/chapters/" + first.chapter.id;
      const sent = await request(3, "POST", path + "/send", 201, { content: "River.", ...writeGuard(first.version.id) });
      const context = await browser.newContext({ viewport: { width: 1262, height: 900 }, hasTouch: touch });
      await context.addInitScript(id => localStorage.setItem("axis.lastSeriesId", id), tree.series.id);
      const page = await context.newPage();
      await page.goto("http://localhost:4173/");
      await part(page, "chapter-open").focus();
      await page.keyboard.press("Enter");
      const editor = await part(page, "editor").elementHandle();
      assert.ok(editor);

      let posts = 0, listReads = 0;
      let letCheckFinish;
      const checkGate = new Promise(resolve => { letCheckFinish = resolve; });
      await page.route("**/api" + path + "/pull-back", async route => {
        assert.equal(route.request().method(), "POST");
        assert.deepEqual(route.request().postDataJSON(), { expected_active_version_id: sent.version.id });
        posts++;
        assert.equal((await route.fetch()).status(), 200);
        await route.abort("failed");
      });
      await page.route("**/api" + list, async route => {
        assert.equal(route.request().method(), "GET");
        listReads++;
        if (listReads === 1) {
          await route.abort("failed");
        } else {
          if (listReads === 2) await checkGate;
          await route.continue();
        }
      });
      await part(page, "chapter-menu-trigger").focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Pull back to Draft" }).focus();
      await page.keyboard.press("Enter");
      const check = part(page, "pull-back-check");
      const failure = part(page, "pull-back-failure");
      await check.waitFor();
      assert.equal(await failure.textContent(), "The chapter could not be pulled back.");
      assert.equal(posts, 1);
      assert.equal(listReads, 1);

      for (const width of [320, 767, 768, 1262]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await style(check, "padding-inline-start"), "56px");
        assert.equal(await style(check, "position"), "sticky");
        assert.equal(await style(check, "inset-block-end"), "0px");
        assert.equal(await style(failure, "inset-block-end"), touch ? "44px" : "32px");
        assert.equal((await check.boundingBox()).height, touch ? 44 : 32);
        assert.equal(await style(check, "font-size"), width < 768 ? "15px" : "14px");
        assert.equal(await style(check, "line-height"), width < 768 ? "22px" : "20px");
        assert.equal(await style(check, "transition-duration"), "0s");
      }
      await check.focus();
      assert.equal(await style(check, "outline-width"), "2px");
      assert.equal(await style(check, "outline-offset"), "-2px");
      for (const theme of ["light", "dark", "sepia"]) {
        await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
        assert.ok(contrast(await style(check, "color"), await style(check, "background-color")) >= 7);
        assert.ok(contrast(await style(check, "outline-color"), await style(check, "background-color")) >= 3);
        if (!touch) {
          await check.hover();
          assert.ok(contrast(await style(check, "color"), await style(check, "background-color")) >= 4.5);
          await page.mouse.down();
          assert.ok(contrast(await style(check, "color"), await style(check, "background-color")) >= 4.5);
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
      }
      await check.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector('[data-part="pull-back-check"]')?.getAttribute("aria-disabled") === "true");
      await page.keyboard.press("Enter");
      assert.equal(await style(check, "cursor"), "default");
      assert.equal(await check.evaluate(node => node === document.activeElement), true);
      letCheckFinish();
      await check.waitFor({ state: "detached" });
      assert.equal(listReads, 2);
      assert.equal(posts, 1);
      assert.equal(await editor.evaluate(node => node.isConnected && node.textContent === "River."), true);
      const history = await request(4, "GET", path + "/history", 200);
      assert.equal(history.active_version_id, sent.version.id);
      assert.equal(history.versions.length, 3);
      assert.equal(history.versions[0].source, "draft_edit");
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
console.log("D18 Binder browser acceptance passed");
