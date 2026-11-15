# The owner reads "staged"; the stored phase stays "staging"

Every word the owner sees for the staging phase reads "staged": the card's phase word and Status row, and the thread line "Marked as staged". The stored phase, `--phase staging`, the `staged` command and the code names stay "staging", so no item file, CLI call or event changes. The "waiting for orchestrator" line stays.

Thread lines written before this change keep their stored text "Marked as staging".
