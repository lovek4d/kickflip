# A topic pill tap puts the topic in the URL

Tapping a topic pill on Open questions replaces the URL hash with the topic's first question id (`history.replaceState`, as the move to the next topic after a Send already does), so back navigation reopens the topic last shown. It replaces rather than pushes: pills are a view within one page, not history steps.
