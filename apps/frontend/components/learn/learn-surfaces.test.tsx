import { renderStatic } from "@/lib/component-render.test-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import { findLearnGuide, LEARN_GUIDES } from "@/lib/learn-content";
import { METRIC_TRUST_COPY } from "@/lib/metric-vocabulary";
import {
  CANONICAL_BUYBACK_EQUATION,
  getPackScoutEvWorkedExample,
} from "@/lib/packscout-ev-examples";
import { RESPONSIBLE_PLAY_RESOURCE } from "@/lib/responsible-play";
import { ArticleLayout } from "./ArticleLayout";
import { LearnIndex } from "./LearnIndex";
import { ResponsiblePlayNotice } from "./ResponsiblePlayNotice";

test("the responsible-play notice renders the verified helpline contact", () => {
  const markup = renderStatic(<ResponsiblePlayNotice />);
  const { helpline } = RESPONSIBLE_PLAY_RESOURCE;

  assert.ok(markup.includes('aria-label="Responsible play"'));
  assert.ok(markup.includes(helpline.callLabel));
  assert.ok(markup.includes(helpline.textLabel));
  assert.ok(markup.includes(helpline.chatLabel));
  assert.ok(markup.includes(`href="${helpline.callHref}"`));
  assert.ok(markup.includes(`href="${helpline.textHref}"`));
  assert.ok(markup.includes(`href="${helpline.chatHref}"`));
  for (const paragraph of RESPONSIBLE_PLAY_RESOURCE.paragraphs) {
    assert.ok(markup.includes(paragraph));
  }
  assert.ok(markup.includes(METRIC_TRUST_COPY.adviceLine));
});

test("the Learn index teaches the buyback method with the shared equation", () => {
  const markup = renderStatic(<LearnIndex guides={LEARN_GUIDES} />);

  assert.ok(markup.includes("How PackScout EV works"));
  assert.ok(markup.includes(CANONICAL_BUYBACK_EQUATION));
  assert.ok(markup.includes(METRIC_TRUST_COPY.adviceLine));
  // The one shared responsible-play block renders on the index.
  assert.ok(markup.includes(RESPONSIBLE_PLAY_RESOURCE.helpline.callLabel));
  assert.ok(
    markup.includes(`href="${RESPONSIBLE_PLAY_RESOURCE.helpline.chatHref}"`),
  );
});

test("the Expected Value article renders shared example values and definitions", () => {
  const guide = findLearnGuide("expected-value");
  assert.ok(guide);
  const markup = renderStatic(<ArticleLayout guide={guide} />);

  // The compact methodology promise and advice line.
  assert.ok(markup.includes(METRIC_TRUST_COPY.dashboardDisclaimer));

  // Canonical example values, exactly as the shared presentation renders
  // them (positive, neutral, negative, zero, and unavailable companions).
  for (const fragment of [
    CANONICAL_BUYBACK_EQUATION,
    "$85.00",
    "85.00%",
    "-$15.00",
    "-15.00%",
    "+$8.00",
    "+8.00%",
    "108.00%",
    "100.00%",
    "-$5.00",
    "-10.00%",
    "-$25.00",
    "-100.00%",
    "Valid $0.00 payout: every supported outcome pays no guaranteed buyback.",
    "Unavailable: documented buyback terms are unavailable.",
    "Not documented",
    "Platform-documented scenario",
    "What PackScout shows",
  ]) {
    assert.ok(markup.includes(fragment), fragment);
  }

  // Worked examples expose accessible names.
  const canonical = getPackScoutEvWorkedExample("canonical_buyback");
  assert.ok(markup.includes(`aria-label="${canonical.title}"`));

  // Canonical glossary definitions render verbatim inside the article.
  assert.ok(
    markup.includes(
      "The expected guaranteed buyback payout: each supported outcome’s final guaranteed buyback payout weighted by its probability",
    ),
  );
  assert.ok(
    markup.includes(
      "The documented uniform buyback rate when one rate governs every eligible outcome; otherwise a bounded summary such as Varies by outcome",
    ),
  );

  // The shared responsible-play block renders on articles too.
  assert.ok(markup.includes(RESPONSIBLE_PLAY_RESOURCE.helpline.callLabel));
});

test("every Learn article carries the shared responsible-play resource", () => {
  for (const guide of LEARN_GUIDES) {
    const markup = renderStatic(<ArticleLayout guide={guide} />);
    assert.ok(
      markup.includes(RESPONSIBLE_PLAY_RESOURCE.helpline.callLabel),
      guide.slug,
    );
    assert.ok(
      markup.includes(`href="${RESPONSIBLE_PLAY_RESOURCE.helpline.callHref}"`),
      guide.slug,
    );
  }
});
