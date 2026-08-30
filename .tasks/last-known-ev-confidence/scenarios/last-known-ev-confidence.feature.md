# Feature: Last-Known EV Confidence

Status: approved — implementation in progress
Owner: product build

## Scenario: A known EV crosses 60 minutes

Given an available buyback-adjusted EV with complete supported evidence
When its source age changes from exactly 60 minutes to 60 minutes plus one millisecond
Then every EV metric remains visible and sortable
And its last-known presentation gains the over-60-minute limitation instead of becoming unavailable

Coverage: Automated contract, publication, query, and frontend coverage is owned by tasks `001`, `002`, `003`, and `005`.

## Scenario: Confidence decays continuously after 60 minutes

Given a last-known estimate with a V1 score of 7,500 at 60 minutes
When PackScout evaluates it at 2 hours, 3 hours, 4 hours, and 7 days
Then its public confidence is 5,000, 2,500, 0, and 0 basis points respectively
And the score never increases or makes the known EV unavailable when it reaches zero

Coverage: Automated integer-arithmetic and boundary coverage is owned by tasks `001` and `003`.

## Scenario: Static evidence limitations remain reflected

Given complete evidence that uses platform-published odds or a closed-range midpoint
When PackScout derives confidence after 60 minutes
Then the corresponding 1,500-point or 2,000-point static penalty is included in the 60-minute base
And the over-60 source-age limitation is disclosed separately

Coverage: Automated contract and presentation coverage is owned by tasks `001` and `005`.

## Scenario: Missing evidence remains unavailable

Given missing essential price, odds, value, buyback, currency, draw, or provenance evidence and no retained valid estimate
When PackScout evaluates the repack
Then EV remains unavailable with a stable bounded reason
And PackScout does not turn missing evidence into a low-confidence estimate

If a prior valid estimate exists, retain its original economics and provenance at zero confidence with the latest unavailable reason instead.

Coverage: Automated calculation regression and public-contract coverage is owned by tasks `001` and `002`.

## Scenario: Provider health is informational

Given a known last-known estimate from a paused, unhealthy, stale, behind-head, or release-misaligned provider
When a buyer opens the catalog
Then the estimate remains visible in rows, details, ordinary sorting, median, and coverage
And it remains eligible for Top Opportunities with provider delay disclosed separately

Coverage: Automated provider-health, ranking, and frontend coverage is owned by tasks `004` and `005`.

## Scenario: Any calculable last-known estimate may rank

Given a known last-known estimate with any informational provider-health state
When Top Opportunities is evaluated
Then the pack may rank under the existing signed EV rules
And its decayed confidence and last-observed time remain visible

Coverage: Automated confidence and ranking coverage is owned by tasks `003`, `004`, and `005`.

## Scenario: Confidence pagination remains stable

Given enough current and last-known estimates for multiple confidence-sorted pages
When a buyer requests the first page and follows its opaque cursor
Then every page reuses the first page's confidence evaluation time
And no row is duplicated or omitted as wall-clock time advances
And provider health is reevaluated at each response's current trusted server time

Coverage: Automated cursor and query coverage is owned by task `003`.

## Scenario: Sold-out history and positive suppression do not change

Given one sold-out pack and one raw calculation with positive signed EV
When the public freshness policy is applied
Then the sold-out pack retains historical economics, continues aging confidence, and never ranks
And a suppressed calculation remains unavailable unless earlier valid economics are explicitly retained at zero confidence

Coverage: Automated regression coverage is owned by tasks `001`, `003`, and `005`.

## Scenario: ClutchPacks adopts the policy without reimport

Given the existing active ClutchPacks Convex release and completed local canonical import
When the new public freshness policy is deployed to the isolated test database
Then known ClutchPacks EV uses the last-known projection from existing release evidence
And no provider reimport or Neon migration occurs

Coverage: Deployment canary and browser evidence is owned by task `006`.
