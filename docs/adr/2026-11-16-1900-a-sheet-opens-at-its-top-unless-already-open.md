# A sheet opens at its top unless it is already open

A sheet the owner reopened kept the scroll it had when it closed, so notes or questions came up part-way down. Every sheet now opens through `BoardUI.openSheet` (`ui.js`): one that isn't open yet shows (modal, or non-modal from 900px) with itself and every scroller inside it set to the top; a call while it is open does nothing, so a repaint, an update or switching what the reader shows inside the open sheet leaves its scroll where it is.

- **Every reused sheet goes through it**: the reader (`app-reader.js`), questions (`app-questions-sheet.js`), New task (`new-task.js`), the architecture, links, waits, main and hold sheets, the board and hub settings modals and the permissions sheet. Sheets built fresh each time (`dialogs.js repoSheet`, `sidebar.js`, `linear-key.js`) have no old scroll to reset and call `showModal` as before.
- **A log that follows its end** (`app-reader.js` `atEnd`/`toEnd`) still scrolls to the end as it reads on; it is the log's own follow, not the sheet's open.
