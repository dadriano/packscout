# Provider-source records per request

## Create with the default

Given an administrator creates a provider source without changing the request size
When the source is saved
Then its maximum records per request is 500
And the first newly created run pins 500

## Preserve an existing source during deployment

Given a provider source existed before this setting was introduced
When the schema migration completes
Then its configured maximum records per request is 500
And deployment alone does not change the request size of its next run

## Save for the next run

Given Courtyard is configured for 500 records per request
And queued or running Courtyard work is pinned to 500
When an administrator saves 1,000
Then the existing work remains pinned to 500
And the next newly created run pins 1,000
And the admin shows `Current run: 500. Next run: 1,000.`

## Reject invalid input

Given an administrator is editing a source
When they submit zero, 5,001, a fraction, or a non-number
Then no source setting changes
And the field says `Enter a whole number from 1 to 5,000.`

## Enforce the pin

Given a provider page request is pinned to 100 records
When the provider returns 101 records
Then that page fails with a safe source-action-required outcome
And no page, checkpoint, canonical record, or EV request is written
And another provider source can continue

## View without editing

Given a data operator can view providers but cannot manage them
When they open the source overview or detail
Then they can read the configured and current-run values
And no control lets them change the value
