# Feature: Repack comparison dashboard

Status: draft — acceptance map for a future implementation; nothing below is built yet
Owner: product build

## Scenario: A buyer compares packs by expected value

Given the pack catalog contains packs from multiple platforms
When the buyer requests the comparison table without any query
Then packs are returned sorted by EV $ from high to low
And every row carries the twelve confirmed comparison fields

Coverage: Planned — domain unit tests plus `apps/frontend/app/api` route behavior tests

## Scenario: A buyer narrows the table to relevant packs

Given packs across several platforms, categories, and prices
When the buyer filters by platforms, categories, and a price range within $10–$12,000
Then only packs matching every active filter are returned
And result counts and pagination reflect the filtered set

Coverage: Planned — domain unit tests plus route behavior tests

## Scenario: Invalid query input is rejected safely

Given the public repacks API
When a request carries an unknown sort key, a malformed price, an out-of-range page, or an inverted price range
Then the request is rejected with a 400 status and a stable `{ error, code }` body
And no partial or unstable response shape is returned

Coverage: Planned — route behavior tests

## Scenario: A buyer understands unfamiliar metrics

Given the buyer is viewing the comparison table
When they inspect any column of the table
Then a glossary definition exists for that column
And glossary hints are enabled by default in the interface

Coverage: Planned — glossary contract unit test; tooltip interaction via browser smoke

## Scenario: EV movement is communicated without relying on color alone

Given packs whose expected value is above, near, and below pack price
When EV values are presented
Then each value resolves to a positive, neutral, or negative semantic state
And the state is expressed with a textual indicator alongside color

Coverage: Planned — state resolution and indicator contract unit tests

## Scenario: A buyer follows a Pack Link without losing tracking

Given a pack whose platform listing URL already carries tracking parameters
When the dashboard renders the outbound Pack Link
Then existing query parameters are preserved
And Packscout's referral source parameter is present exactly once

Coverage: Planned — link-building unit tests

## Scenario: A buyer copies a public promo code

Given a pack with a public promo code
When the buyer activates the copy control
Then the code is placed on the clipboard
And the interface confirms the copy through an accessible status message

Coverage: Planned — manual gap expected (clipboard needs a real browser); revisit when component-level DOM test infrastructure exists

## Scenario: A buyer learns the basics before purchasing

Given the Learn section
When the buyer opens it
Then exactly three launch articles are available: "What is a repack?", "What is Expected Value (EV)?", and "Repack Red Flags"
And an unknown article address resolves to not-found rather than an error page

Coverage: Planned — content contract unit test; navigation via browser smoke

## Scenario: The dashboard remains usable across viewport sizes

Given the dashboard and Learn pages are rendered in a browser
When they are viewed at desktop and mobile widths
Then content remains readable and operable, with the table scrolling inside its own region
And there is no page-level horizontal overflow or browser console error

Coverage: Planned — manual browser smoke at 1440×1000 and 390×844; consider visual regression tooling when interactions grow
