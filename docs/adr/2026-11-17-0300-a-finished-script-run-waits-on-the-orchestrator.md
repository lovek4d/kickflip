# A finished or declined script run waits on the orchestrator

Status: accepted

A script-result or script-decline woke the orchestrator's watcher but opened no
wait, so the card's next stayed what it was (on T-570, the owner's Done).

The newest script-result or script-decline on a card is now an orchestrator
wait of kind `script`, since that event. It clears at the orchestrator's next
thread line, verify or builder start on the card (the same writes that end
other waits), and the watcher prints it as a waits line like any other.
