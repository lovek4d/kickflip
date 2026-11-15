# An owner's message is written before the lines its tap causes

An Implement or Reply message on a Todo card used to run its effects (`stageImplement`, `stageReply`: "Resumed",
"Marked as staging", the notes) before the message event was appended, so those lines carried earlier timestamps and sat
above the message in the thread. The board server now appends the message event first and runs the tap's effects after
it. A bare Implement writes no message and is unchanged.
