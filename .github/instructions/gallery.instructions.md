---
description: "Use when working on the gallery: the Google Drive folder sync, the R2 mirror, the officer upload UI, hiding/restoring a photo, ordering the photos, the service-account credentials, or the gallery manifest. Covers why Drive is the source of truth and R2 the delivery mirror, the reconciliation rules in gallery.ts, the sync batch limits, HEIC rejection, the two registered OAuth redirect URIs, and the gallery test suites."
applyTo: "worker/src/{googleAuth,drive,gallery,gallerySync,galleryUpload}.ts, src/lib/{galleryClient,galleryView,imageConvert,loginRedirect}.ts, src/components/{GalleryUpload,ImageModal}.tsx, src/pages/Gallery.tsx, worker/wrangler.jsonc, src/test/{lib,worker,pages,components}/*gallery*.test.ts, src/test/lib/imageConvert.test.ts, src/test/worker/galleryRoutes.test.ts, src/test/worker/galleryConfig.test.ts, src/test/worker/oauthRedirect.test.ts"
---

# Gallery: Google Drive -> R2 -> the website

Officers upload photos from `/gallery`; Drive holds them; the site serves them.
Everything else follows from those three facts.

## The shape

```
Drive folder  --(cron, 5 min)-->  manifest (KV)  -->  GET /gallery
      ^                                |
      |                                v
   POST /manage/gallery        GET /gallery/image/{id}  <- R2 mirror
```

**Drive is the source of truth.** The team already keeps photos there, and the
requirement is that everything in one folder appears on the site without a
redeploy. Adding a file in the Drive UI is enough.

**R2 is the delivery mirror, not a speed cache.** Cloudflare's edge cache already
handles repeat visitors. R2 exists so a public page view never spends a Drive
API call: Drive's quota is per-user and its download URLs are rate-limited, so
ordinary traffic would start failing for everyone.

WARNING: **Never hotlink Drive.** `webContentLink` and `lh3.googleusercontent.com` are not meant for embedding and rotate. The bytes are streamed into R2 with `alt=media`.

### The R2 binding must be named `GALLERY_BUCKET`

`wrangler.jsonc` declares the bucket under `r2_buckets` with
`"binding": "GALLERY_BUCKET"`, and `worker/src/index.ts` reads
`env.GALLERY_BUCKET` (`handleGetGalleryImage`) plus `gallerySync.ts` reads it for
list/put/delete.

WARNING: **This is a PRODUCTION outage that happened once.** The binding was
renamed to `autoboat_gallery` in `wrangler.jsonc` while the code still read
`GALLERY_BUCKET`. Nothing failed to deploy -- a binding is an untyped string on
both sides -- so `env.GALLERY_BUCKET` was `undefined`, `GET /gallery/image/{id}`
answered **503 "gallery not configured"**, and every tile on `/gallery` rendered
broken while the manifest happily kept listing the photos. Check the Worker logs
for a 503 on `/gallery/image/` before suspecting Drive.

WARNING: **A binding rename is a two-file change, and the deploy will not
tell you.** `src/test/worker/galleryConfig.test.ts` parses `wrangler.jsonc` and
compares every `*_BUCKET` / `*_KV` name the Worker reads off `env` against the
declared bindings, so a one-sided rename fails there. Do not delete that test
because "the config is obviously right" -- it was obviously right the last time.

## Why a service account, and why it must be a Shared Drive

A service account is the right credential because the gallery is **public**: a
visitor has no Google account, so the Worker must read the folder on its own
authority. That is the two-legged OAuth flow.

WARNING: **A service account has NO storage quota.** Google's docs: service accounts "don't have storage quota and can't own files. Instead they must upload files and folders into shared drives, or use OAuth 2.0 to upload items on behalf of a human user." So the folder must live in a **Shared Drive**, and a personal `@gmail.com` account cannot create one. The drive account is `autoboat@vt.edu`.

The fallback, if VT has no Shared Drives on its plan, is domain-wide delegation
via `GOOGLE_IMPERSONATE_EMAIL`. It needs a Workspace super-admin to authorize the
service account's numeric client id, so it is an institutional request rather
than a self-serve setting.

WARNING: **Drive answers 404, not 403, when the service account cannot see a Shared Drive folder.** A wrong folder id and an unshared folder are therefore indistinguishable from the error alone. Check the Share step first.

WARNING: **`supportsAllDrives=true` is required on every Drive call.** Without it, files in a Shared Drive 404 even though they plainly exist.

## No Google client library

`worker/src/googleAuth.ts` builds the RS256 JWT assertion with Web Crypto and
exchanges it at Google's token endpoint. The `googleapis` packages assume Node
built-ins and a filesystem the Workers runtime lacks, and the Drive API does not
accept a raw JWT as a bearer token.

Assertion claims that are easy to get wrong:

- `iss` is the service account's **email**, not the project id.
- `aud` is the **token endpoint**, not the API being called.
- `scope` is **space**-separated. A comma-separated list is read as one nonsense scope and fails with `invalid_scope`.
- `exp` must be within 60 minutes of `iat`; 55 leaves room for clock skew.
- `sub` is present **only** for delegation. An empty string asks Google to impersonate nobody.

The token is cached per isolate, keyed by identity + scopes + impersonation, so
a sync does not mint one per image. The cache holds a shared credential, not
per-request state, so there is no cross-request leak.

## The reconciliation rules (`worker/src/gallery.ts`)

Pure, so the rules are unit-testable. The three-way merge is the part to
understand: Drive files are what the team has, R2 objects are what has been
copied, and the manifest is what the page renders.

WARNING: **A naive `manifest := Drive files` publishes images before their bytes exist**, so every visitor sees broken tiles until the next sync. And `manifest := R2 only` hides a new upload for two syncs instead of one. The manifest carries a `pending` list and `renderableEntries()` filters on `mirroredAt`, so the page is never told about an image it cannot load.

WARNING: **`MAX_MIRRORS_PER_SYNC` is a hard requirement, not tuning.** A Worker invocation has a wall-clock and subrequest limit, so a folder with hundreds of new photos cannot be copied in one run. Attempting it times out with nothing recorded, and the same batch retries forever. A bounded batch makes progress monotonic.

WARNING: **A previous `mirroredAt` must survive a re-list.** Deriving it from the current R2 listing alone is correct, but dropping it on a metadata-only refresh makes every sync re-copy the whole folder.

WARNING: **The R2 delete sweep must only touch the `gallery/` prefix.** Anything else in the bucket belongs to something else and must never be swept merely because it is not a gallery image.

## Upload (`worker/src/galleryUpload.ts`)

- **Size**: `MAX_UPLOAD_BYTES` is 4.5 MB, deliberately under Drive's 5 MB multipart ceiling, because the envelope adds the metadata part on top of the file.
- **Type**: an allowlist of JPEG, PNG, WebP, GIF, AVIF.
- **Bytes are sniffed**, because `File.type` is the OS's guess at the extension.

### Everything is converted to WebP before upload

`src/lib/imageConvert.ts` (`toWebp`) re-encodes the file in the browser before it
is sent, so BOTH the Drive copy and the R2 mirror are WebP.

WARNING: **The Worker cannot do this conversion.** Cloudflare Workers have no image encoder -- `sharp` and every native codec are unavailable -- so a conversion there is not an option. The browser's `createImageBitmap` + `canvas.toBlob` is both free and the only path, and it makes the UPLOAD smaller too, which matters on a phone at a regatta.

WARNING: **The conversion replaces the bytes in Drive.** The uploaded file is the WebP, not the camera original. `WEBP_QUALITY` is therefore 0.9 (typically 25-35% smaller than the JPEG with no visible difference) rather than a size-first setting. If the team ever wants true originals archived, they must keep them outside this folder.

WARNING: **Conversion failure must NEVER block an upload.** Every failure path -- an unsupported codec, an oversized canvas, a decode error, a result that is not smaller -- returns the ORIGINAL file with `converted: false`. A gallery that refuses an upload because an optimization failed is worse than a gallery with a JPEG in it. `imageConvert.test.ts` pins each path.

WARNING: **The dimension clamp runs BEFORE the canvas.** `canvas.toBlob` silently returns an EMPTY blob once the canvas exceeds the browser's area limit (Chrome ~268 MP, Safari lower), which looks like an encoder failure rather than a size problem. `MAX_CONVERT_DIMENSION` (4096) keeps a 48 MP phone photo convertible.

NOTE: An already-WebP upload is passed through untouched -- re-encoding a lossy format only loses quality.

WARNING: **HEIC is checked BEFORE the generic allowlist.** It is the iPhone default, no browser can render it, and the generic "unsupported type" message does not tell the user there is a setting that fixes it. Ordering matters: HEIC is not in the allowlist, so the generic branch would otherwise swallow it -- which is exactly what happened until a test caught it.

WARNING: **Subfolders are not traversed.** Only direct children of the configured folder are published. Recursing would let an unrelated folder dragged into the tree publish itself by accident.

## Routes

| Route | Auth | Notes |
| ----- | ---- | ----- |
| `GET /gallery` | public | Manifest; only mirror-complete, non-hidden images. |
| `GET /gallery/image/{id}` | public | Streams from R2, immutable-cached. |
| `POST /manage/gallery` | officer session | Writes Drive, then mirrors. |
| `PATCH /manage/gallery/{id}` | officer session | Hides or restores one photo. |
| `GET /manage/gallery/hidden` | officer session | The removed photos, for restore. |
| `GET /manage/gallery/order` | officer session | Visible photos, in display order. |
| `PUT /manage/gallery/order` | officer session | Sets the display order. |
| `POST /manage/gallery/sync` | `GALLERY_SYNC_TOKEN` | For CI or an operator. |

## Hiding a photo does NOT delete it

Officers can take a photo off the public page from the lightbox ("Remove from
gallery") and put it back from the "Removed from the gallery" list in the Add
photos panel.

WARNING: **Nothing is deleted.** The Drive file, the R2 mirror, and the manifest entry all stay. Removing a photo flips one boolean. That is the requirement: an officer who removes the wrong photo must be able to undo it in one click, and this Worker has no way to recover a deleted Drive file. Do not "optimize" this into a delete or an R2 sweep.

WARNING: **The hidden set lives on its OWN KV key (`gallery:hidden:v1`), not only in the manifest.** The manifest is rebuilt from Drive on every sync, so a flag stored only there is erased the moment the folder is re-listed and every removed photo comes back. `syncGallery` must load the set and pass it to `buildManifest`; `gallerySync.test.ts` pins that, because a test that hands `buildManifest` a hidden set directly passes even when the sync forgets to.

WARNING: **`hidden` is a strict `=== true` when parsing** (in both `parseManifest` and the route's body check). A truthiness read would treat `"false"` as hidden, silently hiding a photo the caller meant to restore.

NOTE: Hidden photos stay MIRRORED on purpose: the restore list shows their thumbnail, and restoring is then instant rather than "reappears after the next sync". The delete sweep only removes bytes for files that left DRIVE, so a hidden photo is never swept.

NOTE: The hide route costs two KV writes (the hidden set, then the manifest). Both are officer-initiated and rare, so the read path's one-write-per-miss budget is untouched.

## Reordering photos

A signed-in officer drags photos **directly on the grid** -- no panel to open.
This is the ONLY reorder UI; the panel used to carry a duplicate drag list and it
was removed.

WARNING: **The saved order is a list of TILE KEYS (`drive:<id>` / `site:<src>`), not Drive ids.** The grid is half Drive photos and half curated photos compiled into the site, and the Worker only knows the Drive half -- an id-only sequence can therefore only describe part of the page, which is exactly what made "some images can't be reordered". Keys are unique across both sources, so one sequence covers the whole grid: the Worker sorts its own entries and the browser applies the rest.

WARNING: **`DRIVE_TILE_PREFIX` is duplicated** in `worker/src/gallery.ts` and `src/lib/galleryView.ts`. The site cannot import from the Worker (that code must not ship in the bundle), so changing one literal silently breaks matching against saved orders. Edit both, and keep `galleryOrder.test.ts` pinning the format.

WARNING: **Every tile is draggable for an officer, curated photos included.** Do not reintroduce a `photo.driveId` check on `canReorder` -- that was the bug. `driveId` still gates REMOVAL (the hide endpoint needs it) and nothing else.

NOTE: The put route still accepts a bare `{ "ids": [...] }` body and normalizes each entry to `drive:<id>`, so a hand-written curl call keeps working.

WARNING: **Native HTML5 drag does not fire on touch devices** (`dragstart` never happens on a phone), and a `draggable` `<button>` cannot be dragged from the keyboard. Reordering is therefore desktop-pointer-only today. There is no button fallback -- that went with the panel list, and restoring one means either a touch-capable drag implementation or a per-tile move control on the grid.

WARNING: **A drag is usually followed by a `click`, which would pop the lightbox for the photo just moved.** `dragEnd` clears the drag state BEFORE that click runs, so an `if (dragKey) return` guard is dead code -- it passes in a test that fires `click` by hand but not in a real browser. The guard is a timestamp (`lastDragEndRef`, 250ms window). A ref, not state: it would otherwise re-render the grid on every drag for a value only the click handler reads. `Gallery.test.tsx` pins it.

WARNING: **Only DRIVE tiles are draggable, and only when a session exists.** A curated photo is part of the site's design and has no server-side position, so marking it draggable would promise a move the save cannot honour -- `reorderTo` also refuses a drop onto one. A visitor's tiles get `draggable="false"`, because a tile that lifts on drag and snaps back reads as broken.

NOTE: The drop is OPTIMISTIC. `pendingOrder` holds the reordered id list so the grid does not snap back while the refetch is in flight, and it is cleared whenever a fresh manifest arrives so the page converges on the server's answer. A failed save clears it and reports the error -- showing a saved-looking arrangement that was not stored is worse than a jump.

The order itself lives on its own KV key (`gallery:order:v1`), exactly like the
hidden set, and `syncGallery` must load it and pass it to `buildManifest`. The
manifest is rebuilt from Drive on every cron run, so an order stored only there
reverts to newest-first within five minutes. `galleryOrderSync.test.ts` pins
that wiring.

WARNING: **The order lives on its OWN KV key (`gallery:order:v1`)**, exactly like the hidden set, and `syncGallery` must load it and pass it to `buildManifest`. The manifest is rebuilt from Drive on every cron run, so an order stored only there reverts to newest-first within five minutes. `galleryOrderSync.test.ts` pins that wiring.

WARNING: **A partial order is normal, not a bug.** Ids are not pruned when a photo leaves Drive, and a photo uploaded after the order was set is not in the list at all. `sortEntriesByOrder` therefore puts listed ids first in their given sequence and appends everything else in the default newest-first order. Do not "fix" this by dropping unlisted photos -- that would silently hide every new upload.

WARNING: **The whole sequence is sent, not a single move.** A `(from, to)` pair is ambiguous once another officer can upload between the render and the request; sending the full list means "this is the order", which is idempotent and safe to retry. `moveInOrder` exists only as the pure helper for computing that list on the client side.

WARNING: **`sortEntriesByOrder` builds a `Map` of ranks rather than calling `indexOf` per comparison.** With `indexOf` the comparator does an O(n) scan on every comparison, making the sort O(n^2 log n) on a large gallery.

NOTE: Each move costs two KV writes (the order, then the manifest) on an officer-initiated path. The read path's one-write-per-miss budget is untouched.

NOTE: The list is buttons, not drag-and-drop: a drag handle is unusable by keyboard and invisible to a screen reader, and it fights page scrolling on a phone. Each button's `aria-label` names the photo (`Move <name> earlier`) because "Move up" alone is meaningless out of context.

NOTE: Hidden photos are excluded from the reorder list -- arranging a position for one would be invisible work. A restored photo lands at the end of the custom order.

NOTE: The drop indicator is an `inset box-shadow`, not a border, so showing and hiding it cannot change a row's height and shift the list mid-drag. The dragged row is dimmed (not removed) for the same reason.

WARNING: **`onDragOver` must call `preventDefault()`**, or the row is not a valid drop target and `drop` never fires. It also guards its `setState` on the hovered index changing -- `dragover` fires continuously and an unguarded setState re-renders the list on every pointer move.

## The committed gallery folder is gone

`public/images/gallery/` no longer exists. The general team photos it held now
live in the Drive folder and arrive at runtime, so `GALLERY_PHOTOS` was removed
and `ALL_GALLERY_IMAGES` is exactly the flattened `SUBTEAM_IMAGES`.

WARNING: **Three of those files were load-bearing outside the gallery**, which is why they were moved rather than deleted: `14.webp` was the home hero background, the Theseus photo, AND `og:image`; `13.webp` was Lumpy; `16.webp` was Ducky. They now live at `/images/hero.webp` and `/images/fleet/{ducky,theseus,lumpy}.webp`.

WARNING: **Pages that are not galleries keep their photos in `public/images/`.** The home hero, the Fleet vessels, and the social preview must render without a call to the Worker -- a Drive photo would make the home page's first paint depend on the gallery API. Only `/gallery` is Drive-backed.

NOTE: Adding a photo for Meet the Team / subteam content still means editing `src/lib/galleryImages.ts` and redeploying. That is intentional: those are editorial images that appear alongside copy, not the team's photo library. Anything the team wants to add casually goes in Drive.

WARNING: **The route check is the only gate on upload AND on hide.** The Drive write uses the service account's credentials, so Google enforces nothing about the caller -- the same shape as event creation. Both reuse `canCreateEvents` rather than adding a parallel flag, because "may manage the team's public presence" is one decision and two flags would drift.

WARNING: **`/gallery` and `/gallery/image/*` must stay OUT of the management CORS group** in `index.ts`. Putting them in advertises POST/DELETE and an Authorization header on public image endpoints and makes the browser preflight every image.

WARNING: **`/gallery` returns 503, not an empty 200, when Drive is unconfigured.** An empty list reads as "all the photos are gone". The message names the missing variable -- names only, never values, because it is a public response.

## Sign-in completes on the page it started on

`/calendar/` and `/gallery/` are both registered Discord redirect URIs, listed
comma-separated in `OAUTH_REDIRECT_URI`. The Worker selects the entry whose
**path** matches the requested return page.

WARNING: **The redirect URI is SELECTED, never constructed.** Building one from a path would make any path a target; `RETURN_PATH_ALLOWLIST` exists so nothing outside it is reachable.

WARNING: **The authorize request and the token exchange must send the SAME redirect URI**, or Discord rejects the exchange with `invalid_grant`. Both call `redirectUriFor` with the return path recovered from the signed state.

WARNING: **The return path is an open-redirect candidate.** It rides through Discord and is used to navigate. `resolveReturnPath` rejects absolute URLs, protocol-relative values (`//evil.example` -- the case a naive `startsWith("/")` misses), and anything off the allowlist.

The `?code=` exchange lives in **one** place, `src/lib/loginRedirect.ts`, because
two pages now receive a redirect and the code is single-use. Duplicating it would
mean one copy eventually replays a spent code.

WARNING: **A successful sign-in leaves the Add photos panel CLOSED.** It used to
call `setOpen(true)`, which reads as the officer having clicked "Add photos" for
them -- they clicked "Officer sign-in", and the upload form is a separate
decision. The confirmation is the toggle's label flipping from "Officer sign-in"
to "Add photos"; the form waits to be asked for. Do not restore the auto-open on
the success branch. A REFUSAL or a failed exchange still opens the panel, because
those messages have nowhere else to render -- `GalleryUpload.test.tsx` pins both
halves.

## Tests

- `src/test/worker/gallery.test.ts` -- reconciliation: mirror time surviving a re-list, clearing it when bytes vanish, `renderableEntries` excluding pending AND hidden, the delete sweep ignoring non-gallery keys, ordering, `parseManifest` tolerance.
- `src/test/worker/galleryHidden.test.ts` -- the hide/restore endpoints: that a hide leaves the mirror untouched, that the entry survives with only the flag changed, the strict-boolean body check, and the officer-only gate.
- `src/test/worker/gallerySync.test.ts` -- drives `syncGallery` itself with the Drive client mocked. This is the only place the hidden set's WIRING is checked: removing the `loadHiddenIds` call from the sync fails this file while every pure test stays green.
- `src/test/worker/galleryUpload.test.ts` -- magic-byte sniffing per format, HEIC identification, filename sanitizing, size/type limits, and that the limit stays under Drive's ceiling.
- `src/test/worker/galleryRoutes.test.ts` -- the auth gate (unauthenticated, forged, member, expired), the HEIC message end to end, public-vs-management CORS, and the return-path allowlist.
- `src/test/worker/galleryConfig.test.ts` -- the `wrangler.jsonc` <-> code binding agreement (see "The R2 binding must be named `GALLERY_BUCKET`"). This is a production-incident regression test: the R2 binding had been renamed away from `GALLERY_BUCKET` and every gallery image 503'd.
- `src/test/worker/oauthRedirect.test.ts` -- `resolveReturnPath`, `parseRedirectUris`, `redirectUriFor` selection and fallback.
- `src/test/worker/galleryOrder.test.ts` -- the pure ordering rule: listed ids first, unlisted appended newest-first, stale ids harmless, first-occurrence-wins for duplicates, `moveInOrder` clamping, `parseOrder` tolerance.
- `src/test/worker/galleryOrderSync.test.ts` -- the WIRING, through `syncGallery` with the Drive client mocked. Removing the `loadOrder` call fails this file while every pure ordering test stays green.
- `src/test/worker/galleryOrderRoutes.test.ts` -- the order endpoints: auth, body validation (non-array and non-string entries both 400), the immediate manifest re-sort, and that `/manage/gallery/order` is claimed before the `{id}` route.
- `src/test/components/GalleryUpload.test.tsx` -- the officer panel: sign-in vs upload controls, the oversized-file rejection stopping before the POST, the restore list, and that a successful `?code=` login leaves the panel COLLAPSED while a refusal opens it.
- `src/test/lib/galleryView.test.ts` -- merge order, dedupe by src, alt text from filenames, status wording, and that `tileKeysOf` covers BOTH sources (the curated-tile reorder bug).
- `src/test/lib/imageConvert.test.ts` -- WebP conversion: filename rewriting, the dimension clamp, and that every failure path returns the untouched original.

WARNING: **The `DRIVE_FILE_ID` check must accept short ids.** It was `{10,128}` and every image-route test 404'd; real Drive ids are 28-44 chars but a fixture or a Shared Drive id can be shorter, and only the CHARACTER SET actually matters because the value becomes an R2 key and a path segment.

## Cost

The cron runs every 5 minutes = 288 KV writes/day, sharing the free tier's
1,000/day budget with the events cache (~480/day at a 180 s TTL). Both are
comfortable but they are the same limit, so do not tighten either without redoing
that arithmetic. The cron and `MANIFEST_TTL_SECONDS` are aligned deliberately.
