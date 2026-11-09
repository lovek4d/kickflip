# A failed upload chip retries on click

An errored file chip in a composer (attach.js) retries its upload when clicked, from the File kept on the pending entry (`p.source`), going back to uploading with fresh progress. "Over 20 MB" can't succeed on retry, so that chip stays remove-only and its title says so. A retryable chip shows "· tap to retry" and a pointer cursor.
