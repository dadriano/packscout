# Feature: Watchlist

Status: draft
Owner: watchlist/001 through watchlist/004

## Scenario: A signed-in user opens Watchlist and sees both saved collections

Given an admitted signed-in user has saved at least one repack and one chase card
When they open Watchlist from the primary nav
Then they see Repacks and Chase cards tabs
And each tab pip equals the number of rows in that tab
And the lists show those saved items newest first

Coverage: Automated — watchlist/002 and watchlist/003 verification

## Scenario: Tab pips include empty and stale saves

Given a signed-in user has zero saved chase cards and one saved repack that has left the current catalog
When they open Watchlist
Then the Chase cards pip is 0 and that tab shows empty copy
And the Repacks pip is 1
And the stale repack remains listed and labeled as no longer in the catalog

Coverage: Automated — watchlist/001 and watchlist/003 verification

## Scenario: A signed-out visitor cannot browse Watchlist in the nav

Given a signed-out visitor is on Dashboard
When they look at the primary nav
Then Watchlist is not present
And opening the Watchlist URL asks them to sign in
And no saved rows are shown

Coverage: Automated — watchlist/002 verification

## Scenario: Another user's saves never appear

Given user A and user B each have their own saved items
When user A loads Watchlist
Then only user A's rows and counts are returned
And user B's public ids are absent

Coverage: Automated — watchlist/001 verification

## Scenario: A user unsaves from Watchlist

Given a signed-in user is viewing a Watchlist row they own
When they unsave that row
Then the row leaves the list
And that tab's pip decreases by one
And the matching bookmark control for the same item is no longer saved

Coverage: Automated — watchlist/004 verification

## Scenario: A user opens a saved item from Watchlist

Given a signed-in user has a resolved saved repack and a resolved saved chase card
When they open the repack from Watchlist
Then they leave Watchlist and see that pack's inspector on All Repacks
When they open the chase card from Watchlist
Then they leave Watchlist and see All Repacks filtered to that collectible

Coverage: Automated — watchlist/004 verification

## Scenario: A stale Watchlist row cannot open

Given a signed-in user has a saved item that is no longer in the current catalog
When they view that row on Watchlist
Then Open is disabled
And Unsave still works

Coverage: Automated — watchlist/004 verification
