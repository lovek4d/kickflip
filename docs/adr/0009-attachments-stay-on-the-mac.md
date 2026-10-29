# Attachments are stored on the Mac, beside the site's data, and reach Claude by path

A file attached to an ask, a thread message or a question note is uploaded to the site's `data/uploads/`. It can be an image or any other file, up to 20 MB. The event that carries it lists `{name, url, path, type, size}`, so the session reads the file from disk. Only `/uploads/<file>` is served out of `data/`.

The owner wanted screenshots and files from the phone, in all three places (round `site-v7`). Keeping them on the Mac avoids any third-party store, and matches the hub only being reachable on the tailnet.
