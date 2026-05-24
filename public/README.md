# Static assets

Everything here is served from the site root, so `public/background.jpg` is
fetched as `/background.jpg`.

## The backdrop

Two derivatives of the same photograph, both committed:

| File | Size | Used by |
| --- | --- | --- |
| `background.jpg` | 2560×1440, ~152 kB | screens wider than 900px |
| `background-1280.jpg` | 1280×800, ~48 kB | everything narrower |

`src/styles.css` picks between them with a media query, so a phone never
downloads the large one.

### Regenerating them

Put the full-resolution original at `assets-src/background-original.jpg` (that
folder is git-ignored — the source file is several megabytes and only the
derivatives need to ship), then:

```bash
npm install --no-save sharp
node -e "const s=require('sharp');for(const v of [{o:'public/background.jpg',w:2560,h:1440,q:70},{o:'public/background-1280.jpg',w:1280,h:800,q:68}])s('assets-src/background-original.jpg').resize(v.w,v.h,{fit:'cover'}).modulate({brightness:0.88,saturation:0.92}).jpeg({quality:v.q,progressive:true,mozjpeg:true}).toFile(v.o)"
npm uninstall sharp
```

The brightness and saturation trim exists so the photograph stays a texture
rather than competing with the interface.

### Constraints

Prefer something dark, wide and quiet. The layer stack in `src/styles.css`
scrims the image from 62% at the masthead to 94% under the content, so a busy
or bright picture costs legibility without adding information — the current one
has a mean luminance of 23/255 and leaves body text at roughly 6.5:1 even over
its brightest pixel.

The image is optional by construction: a teal gradient and a solid colour sit
underneath it, so the interface keeps its WCAG AA contrast whether it is
present, missing, or still loading. Nothing is measured against the photograph,
and `src/app/ui/palette.spec.ts` fails the build if that ever stops being true.
