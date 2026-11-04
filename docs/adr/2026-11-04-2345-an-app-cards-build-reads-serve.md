# An app card's Build reads Serve, and the Auto-build setting reads Auto serve

The owner asked for one verb for both kinds of board: "auto build setting should read auto serve to make it less ambiguous, and build text should also be serve (even if the output varies between install and visit)".

- The Settings label is "Auto serve"; the setting's key stays `auto_build`.
- An app card's button, running badge, failure badge and Settings lines say Serve, serving…, serve failed, as a web card's do. Its done badge stays Install.
- The CLI command `build <key> --asked` and `settings set auto-build` keep their names.
