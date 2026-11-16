# reply --questions puts its questions on the task it names, and refuses any other topic

Status: accepted (#671)

`reply <file>/<id> --questions <file>` passed the file through untouched, so a question with another topic (a different task, or an undeclared one) posted without ever showing on the task replied to.

- A question with no `topic` gets `item:<file>/<id>`, the task the reply names.
- A question naming any other topic is refused before the message posts. The error names the right command: `thread <other> --questions <file>` for another task's topic, `question add --file <file>` for a declared topic.
- `thread --questions` is unchanged: a thread's key can be a file, so it does not default.
