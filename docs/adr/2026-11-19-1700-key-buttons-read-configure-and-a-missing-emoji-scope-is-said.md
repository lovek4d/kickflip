# Key buttons read Configure, and a missing emoji scope is said

- The Integrations rows' key button for Linear and Slack reads **Configure** once a key is saved (it still reads Add key before), replacing Change key from [Linear and Slack keys open in modals from their Integrations rows](2026-11-09-2230-linear-and-slack-keys-open-in-modals-from-their-integrations-rows.md).
- The hub reads Slack with the owner's user token, so `emoji.list` needs `emoji:read` as a User Token Scope; a bot scope doesn't reach it. When Slack answers `missing_scope`, Hub › Slack's emoji section shows a warning saying so (`warning` in `prEmojiView`) instead of listing no custom emoji silently. Any other failure still reads as no custom emoji.
