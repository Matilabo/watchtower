# Static assets

Everything in this folder is served from the site root, so `public/background.jpg`
is fetched as `/background.jpg`.

## background.jpg

The page background. Drop any wide, dark, low-contrast image in here under that
exact name.

It is deliberately optional: `src/styles.css` layers a teal gradient *underneath*
the photograph and paints a solid `--wt-bg` behind that, so the interface keeps
its WCAG AA text contrast whether the image is present, missing, or still
loading. Nothing is measured against the photo.

Prefer something dark and quiet. Every panel sits on a translucent surface, so a
busy or bright image costs legibility without adding information.
