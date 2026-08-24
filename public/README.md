# Static assets

Everything here is copied verbatim into the build output and served from the
site root.

## `.nojekyll`

GitHub Pages runs Jekyll over a site unless this file is present, and Jekyll
silently drops files and directories whose names begin with an underscore. No
current build output starts with one, so this is insurance rather than a fix:
it costs nothing and removes a whole class of "works locally, 404s on Pages".

## What is *not* here

The backdrop photographs used to live in this folder and are now in
`src/assets/`, documented there. They are bundler assets because a file copied
verbatim can only be referenced by an absolute URL, and an absolute URL breaks
as soon as the app is served from a subpath, which is how GitHub Pages serves a
project site.
