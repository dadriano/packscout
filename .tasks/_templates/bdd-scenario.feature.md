# Feature: <feature name>

Status: draft
Owner: <task or person>

## Scenario: <actor achieves an outcome>

Given <starting context>
When <the actor performs an action>
Then <the observable outcome occurs>
And <the important invariant remains true>

Coverage: Automated — `<test file or command>`

## Scenario: <invalid or forbidden behavior is rejected>

Given <invalid, unauthorized, or conflicting context>
When <the action is attempted>
Then <the request is rejected safely>
And <no forbidden side effect occurs>

Coverage: <Automated, Manual gap with reason, or Not applicable>
