# New board requires a Description, which the hub routes requests by

New board's "What it's for" (optional) becomes **Description**, required. Start stays off while it is empty, the field holds at most 240 characters, and its hint reads "Used by the hub for request routing". `POST /_hub/new-board` refuses a request with no description, so the CLI and the page agree. The wire field is still `purpose`, and the board's session still starts with `--description`.

The router (T-230) reads each board's description to pick where a request goes; a board with none printed `Description: none` and routed worse. Keeping the description fresh (T-527) and editing it in Board settings (T-528) are separate cards.
