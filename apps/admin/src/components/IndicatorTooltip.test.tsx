import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { IndicatorTooltip } from "./IndicatorTooltip.tsx";
import { cleanupPage, renderPage } from "../testing/react-page-test.tsx";

const explanation = "The database lease is valid. This does not verify the worker process.";

test("keyboard users can read and dismiss an indicator explanation without moving focus", async (context) => {
  const page = await renderPage(<IndicatorTooltip label="Lease active" description={explanation} tone="ready" />);
  cleanupPage(context, page);
  const trigger = page.container.querySelector("button")!;
  assert.equal(page.dom.window.document.querySelector('[role="tooltip"]'), null);

  await act(async () => trigger.focus());
  const tooltip = page.dom.window.document.querySelector('[role="tooltip"]')!;
  assert.equal(tooltip.textContent, explanation);
  assert.equal(trigger.getAttribute("aria-describedby"), tooltip.id);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");

  await act(async () => trigger.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true,
  })));
  assert.equal(page.dom.window.document.querySelector('[role="tooltip"]'), null);
  assert.equal(page.dom.window.document.activeElement, trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("touch clicks toggle the explanation and an outside press closes it", async (context) => {
  const page = await renderPage(<IndicatorTooltip label="Stored rows" description="Includes child and relationship rows." />);
  cleanupPage(context, page);
  const trigger = page.container.querySelector("button")!;
  const visible = () => page.dom.window.document.querySelector('[role="tooltip"]') !== null;

  await act(async () => { trigger.focus(); trigger.click(); });
  assert.equal(visible(), true);
  await act(async () => trigger.click());
  assert.equal(visible(), false);
  await act(async () => trigger.click());
  assert.equal(visible(), true);
  await act(async () => page.dom.window.document.body.dispatchEvent(
    new page.dom.window.Event("pointerdown", { bubbles: true }),
  ));
  assert.equal(visible(), false);
});

test("hover explanations remain available when the pointer moves onto the tooltip", async (context) => {
  const page = await renderPage(<IndicatorTooltip label="Fresh" description="The source reached its head within the freshness window." />);
  cleanupPage(context, page);
  const trigger = page.container.querySelector("button")!;
  await act(async () => trigger.dispatchEvent(new page.dom.window.MouseEvent("pointerover", { bubbles: true })));
  const tooltip = page.dom.window.document.querySelector('[role="tooltip"]')!;
  assert.ok(tooltip);
  await act(async () => {
    trigger.dispatchEvent(new page.dom.window.MouseEvent("pointerout", { bubbles: true }));
    tooltip.dispatchEvent(new page.dom.window.MouseEvent("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  assert.ok(page.dom.window.document.querySelector('[role="tooltip"]'));
  await act(async () => {
    tooltip.dispatchEvent(new page.dom.window.MouseEvent("pointerout", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  assert.equal(page.dom.window.document.querySelector('[role="tooltip"]'), null);
});
