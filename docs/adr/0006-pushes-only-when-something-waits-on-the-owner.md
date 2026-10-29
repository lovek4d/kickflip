# A push goes out only when something waits on the owner, on the hub's schedule

Pushes go out for:
- a question;
- a draft waiting on Ready;
- a step only the owner can run;
- the daily 8am digest;
- a merge summary;
- an item turning stale;
- an answer, and a prototype the owner asked for ([0030](0030-pushes-go-by-kind-and-each-arrives-on-its-own.md)).

Progress doesn't push, and neither do site cards reaching Done, approvals or builders finishing. Answers, replies and questions go at once, merges, drafts on Ready and stale items go when their tick ends, and all of them wait overnight for the first window's start ([0030](0030-pushes-go-by-kind-and-each-arrives-on-its-own.md), [0025](0025-the-hub-polls-github-and-sends-pushes-on-one-interval.md)). `--urgent` bypasses the hold, but only for a critical production issue that someone messaged about. An owner question marked `urgent` shows alone on its page, but pushes like any other question.

The owner set the bar (round `site-v5`): urgent means a production problem worth waking up for, not a blocked build.
