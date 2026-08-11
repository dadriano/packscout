import type { ReactElement } from "react";
import { act } from "react";
import * as React from "react";
import type { TestContext } from "node:test";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

export interface RenderedPage {
  readonly container: HTMLElement;
  readonly dom: JSDOM;
  readonly root: Root;
}

function installBrowserGlobals(dom: JSDOM): void {
  const { window } = dom;
  Object.assign(globalThis, {
    BeforeUnloadEvent: window.BeforeUnloadEvent,
    Element: window.Element,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    React,
    document: window.document,
    getComputedStyle: window.getComputedStyle.bind(window),
    window,
  });
}

export async function renderPage(element: ReactElement): Promise<RenderedPage> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://admin.packscout.test/",
  });
  installBrowserGlobals(dom);
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root");
  if (!container) throw new Error("The page test root was not created.");
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  return { container, dom, root };
}

export async function settlePage(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

export function cleanupPage(context: TestContext, renderer: RenderedPage): void {
  context.after(async () => {
    await act(async () => renderer.root.unmount());
    renderer.dom.window.close();
  });
}

export function pageText(renderer: RenderedPage): string {
  const walker = renderer.dom.window.document.createTreeWalker(
    renderer.container,
    renderer.dom.window.NodeFilter.SHOW_TEXT,
  );
  const text: string[] = [];
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue?.trim();
    if (value) text.push(value);
    node = walker.nextNode();
  }
  return text.join(" ");
}

export function findButton(
  renderer: RenderedPage,
  label: string,
  occurrence = 0,
): HTMLButtonElement {
  const matches = [...renderer.container.querySelectorAll("button")]
    .filter((button) => button.textContent?.trim() === label);
  const match = matches[occurrence];
  if (!match) throw new Error(`Button not found: ${label} (${occurrence})`);
  return match;
}

export function changeControl(
  renderer: RenderedPage,
  id: string,
  value: string,
): void {
  const control = renderer.container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
  if (!control) throw new Error(`Form control not found: ${id}`);
  const prototype = control instanceof renderer.dom.window.HTMLSelectElement
    ? renderer.dom.window.HTMLSelectElement.prototype
    : renderer.dom.window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error(`Form control cannot be changed: ${id}`);
  setter.call(control, value);
  control.dispatchEvent(new renderer.dom.window.Event(
    control instanceof renderer.dom.window.HTMLSelectElement ? "change" : "input",
    { bubbles: true },
  ));
}

export interface RecordedRequest {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}

export function stubFetch(
  context: TestContext,
  handler: (
    request: RecordedRequest,
    requestIndex: number,
  ) => Promise<Response> | Response,
): RecordedRequest[] {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = async (input, init) => {
    const request = { input, init };
    requests.push(request);
    return handler(request, requests.length - 1);
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  return requests;
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
