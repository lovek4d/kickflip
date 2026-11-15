# An open card's link rows are comma-separated text, oldest first

Extends 2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md.

Parent, Children, Related to, Blocked by and Waits on it each read as plain text links joined by ", ", with no chip padding. The board sorts each list by the cards' `created` time, oldest first; a card with no `created` follows those that have one, and ties fall back to the ref's number.
