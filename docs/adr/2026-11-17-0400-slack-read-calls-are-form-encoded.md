# Slack read calls are form-encoded

The Slack client (hub/slack.mjs) sends users.list, emoji.list, search.messages, conversations.history and
conversations.replies as application/x-www-form-urlencoded and every other method as JSON. Slack reads a read method's
arguments only from form encoding or the query string, so a JSON search.messages arrived with no query and answered
invalid_arguments: intake never filed anything. The test Slack (shared/test-helpers.mjs) now drops a JSON body sent to
a read method, so the same mistake fails there.
