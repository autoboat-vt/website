---
description: "Use when working on the gallery upload flow: the Google Drive folder sync, the R2 mirror, the officer upload UI, the service-account credentials, or the gallery manifest. Covers why Drive is the source of truth and R2 the delivery mirror, the reconciliation rules in gallery.ts, the sync batch limits, HEIC rejection, the two registered OAuth redirect URIs, and the gallery test suites."
applyTo: "worker/src/{googleAuth,drive,gallery,gallerySync,galleryUpload}.ts, src/lib/{galleryClient,galleryView,loginRedirect}.ts, src/components/GalleryUpload.tsx, src/pages/Gallery.tsx, worker/wrangler.jsonc, src/test/{lib,worker,pages,components}/*gallery*.test.ts, src/test/worker/galleryRoutes.test.ts, src/test/worker/oauthRedirect.test.ts"
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

WARNING: **HEIC is checked BEFORE the generic allowlist.** It is the iPhone default, no browser can render it, and the generic "unsupported type" message does not tell the user there is a setting that fixes it. Ordering matters: HEIC is not in the allowlist, so the generic branch would otherwise swallow it -- which is exactly what happened until a test caught it.

WARNING: **Subfolders are not traversed.** Only direct children of the configured folder are published. Recursing would let an unrelated folder dragged into the tree publish itself by accident.

## Routes

| Route | Auth | Notes |
| ----- | ---- | ----- |
| `GET /gallery` | public | Manifest; only mirror-complete images. |
| `GET /gallery/image/{id}` | public | Streams from R2, immutable-cached. |
| `POST /manage/gallery` | officer session | Writes Drive, then mirrors. |
| `POST /manage/gallery/sync` | `GALLERY_SYNC_TOKEN` | For CI or an operator. |

WARNING: **The session check is the ONLY gate on upload.** The Drive write uses the service account's credentials, so Google enforces nothing about the caller -- the same shape as event creation. It reuses `canCreateEvents` rather than adding a parallel flag, because "may manage the team's public presence" is one decision and two flags would drift.

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

## Tests

- `src/test/worker/gallery.test.ts` -- reconciliation: mirror time surviving a re-list, clearing it when bytes vanish, `renderableEntries` excluding pending, the delete sweep ignoring non-gallery keys, ordering, `parseManifest` tolerance.
- `src/test/worker/galleryUpload.test.ts` -- magic-byte sniffing per format, HEIC identification, filename sanitizing, size/type limits, and that the limit stays under Drive's ceiling.
- `src/test/worker/galleryRoutes.test.ts` -- the auth gate (unauthenticated, forged, member, expired), the HEIC message end to end, public-vs-management CORS, and the return-path allowlist.
- `src/test/worker/oauthRedirect.test.ts` -- `resolveReturnPath`, `parseRedirectUris`, `redirectUriFor` selection and fallback.
- `src/test/lib/galleryView.test.ts` -- merge order, dedupe by src, alt text from filenames, status wording.

WARNING: **The `DRIVE_FILE_ID` check must accept short ids.** It was `{10,128}` and every image-route test 404'd; real Drive ids are 28-44 chars but a fixture or a Shared Drive id can be shorter, and only the CHARACTER SET actually matters because the value becomes an R2 key and a path segment.

## Cost

The cron runs every 5 minutes = 288 KV writes/day, sharing the free tier's
1,000/day budget with the events cache (~480/day at a 180 s TTL). Both are
comfortable but they are the same limit, so do not tighten either without redoing
that arithmetic. The cron and `MANIFEST_TTL_SECONDS` are aligned deliberately.
