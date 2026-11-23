# Motrix Bilibili Resolver

A Bilibili video-link resolver for Motrix 2.x. The original plugin ID remains `community.bilibili-resolver`.

References: [official plugin examples](https://github.com/motrixapp/builtin-plugins), [official SDK](https://github.com/motrixapp/plugin-sdk).

Repository: [Zyphoriate/motrix-bilibili-resolver](https://github.com/Zyphoriate/motrix-bilibili-resolver). [中文说明](README.zh-CN.md) · [Build runs and downloads](https://github.com/Zyphoriate/motrix-bilibili-resolver/actions/workflows/build.yml).

The companion [Motrix fork](https://github.com/Zyphoriate/motrix) integrates media selection and mux task creation. The stock Motrix 2.4.5 limitations described below apply to that original host; integrated hosts can use the public media protocol.

## Changes in 1.3.5

- Names downloads after the video: `Video title.mp4`, or `Video title - P2 Part title.mp4` for multipart videos.
- Persists the filename as task metadata and selects the published name in `beforeFinalize`, declaring the required `metadata` permission. Motrix 2.4.5 ignores the `beforeCreate.filename` result, so this version does not depend on it.
- Reserves filename space for the part number and title when truncating long main titles.
- Tests the entry point with `?p=2`, checking the requested CID and resulting filename.
- Corrects the documentation: DASH support in the public command does not mean Web/NAS task creation supports muxing.

## Media selection protocol

Compatible hosts can call public `community.bilibili-resolver.inspectMedia` with `{url}` to list every part before creating downloads. The v1 result contains stable CID ids, `P<N>` titles, canonical `?p=N` URLs, duration metadata, the fixed `2160p`/`1440p`/`1080p`/`720p`/`480p` choices and default `1080p`. Inspection only reads video metadata and rejects collections over 500 entries. It does not fetch media streams.

For each selected entry, call the existing `.resolve` with `{url: entry.url, quality, cookies?}`. It returns a single DASH video/audio pair at the requested quality (with available lower-quality fallback), preserving the selected part in the title. The host creates tasks and merges streams. The existing progressive hook setting still defaults to `720p`. The manifest also declares `post-action` for its `beforeFinalize` title handling; plugin identity remains unchanged.

## Install

Install `dist/community.bilibili-resolver-1.3.5.moext` and approve `http` and `metadata`. The latter persists the title filename so finalization can use it even after a server restart. The plugin selects the final path in `beforeFinalize`; the host performs the actual rename and collision handling. The plugin does not directly write media files.

Requires Motrix `>=2.0.0 <3.0.0`. Upgrades retain the ID and existing settings. A new task may show a CDN filename while downloading and is published with its title at completion. Tasks created before the upgrade lack title metadata and are not renamed automatically.

## Quality and entry points

| Entry point | Current behavior |
| --- | --- |
| Motrix 2.4.5 Web/NAS Add Task | Calls `beforeCreate` and downloads progressive MP4 with video and audio; anonymous API access normally tops out at 720P |
| A host mux entry point wired to the public resolver command | Receives separate DASH video/audio URLs; the host downloads and merges them using FFmpeg; anonymous 1080P can be requested |

Preferred quality still defaults to `720p`. Choosing `1080p` sets the request ceiling; it cannot make the progressive MP4 endpoint return DASH 1080P.

yt-dlp obtains anonymous 1080P DASH using `try_look=1` and merges the tracks with FFmpeg. This plugin's public command implements that resolution step, but **Motrix 2.4.5 Web/NAS Add Task does not call that command or the mux pipeline**. Installing FFmpeg, supplying a cookie, or choosing 1080P does not complete that missing host integration.

Web/NAS HD muxing requires the host to call the public resolver during task creation and delegate download, merging, cancellation, and recovery to its media coordinator. Version 1.3.5 does not claim to fix this host limitation.

### 4K / 2K request semantics

`2160p` requests Bilibili QN 120 with `fourk=1` and DASH capability flags. `1440p` also requests that ladder and selects the highest available DASH stream whose shorter image dimension is at most 1440 pixels (portrait videos included). Bilibili has no dedicated 1440p QN: 112 means **1080P+**, and 116 means **1080P60**, neither means 2K. When no actual 1440p stream is offered, selection falls back to 1080p or lower; it never relabels 1080P+ as 2K. Unknown dimensions at QN 120 are conservatively treated as 4K. Resolution is selected before codec, with AVC preferred only within the same resolution and QN.

Actual 4K/2K availability depends on the video, account entitlements, cookie, and returned streams. The plugin does not upscale. A compatible host with FFmpeg is required for DASH merging. Protocol reference: [Bilibili playback QN table](https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/video/videostream_url.md).

## Multipart videos

BV, av, b23.tv short links, and explicit `?p=N` part selection are supported:

```text
https://www.bilibili.com/video/BV17Yy3zxE9F/?p=1
https://www.bilibili.com/video/BV17Yy3zxE9F/?p=2
```

Each URL creates one task for the selected part. A URL without `p` defaults to the first part. Automatic expansion of every part is not implemented.

Multiple `uris` in `ctx.update` are mirrors of one file, not separate videos. The plugin SDK provides no child-download creation API, so automatic all-part download requires host support for list expansion and scheduling. For now, add each part's page URL to the task list separately.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Enabled | on | Resolve supported links during task creation |
| Preferred quality | `720p` | `2160p`, `1440p`, `1080p`, `720p`, or `480p`; actual quality depends on the API and host download path |
| Login cookie | empty | Optional SESSDATA or full Cookie header, sent by the resolver only to the Bilibili API; does not guarantee progressive 1080P |

The resolver adds Referer and User-Agent to media requests and prefers stable upos CDN mirrors. WBI signing, response caches, and backoff for 412/429/5xx are included.

## Troubleshooting and old-version circuit state

A working task produces:

```text
bilibili: beforeCreate hook invoked
bilibili: beforeCreate matched a Bilibili URL
bilibili: resolved video link ... filename=Video title.mp4
HTTP task: beforeCreate.output ...
HTTP task: engine.dispatch ...
bilibili: final filename selected filename=Video title.mp4
```

Old-version failures can leave two separate states:

1. A persisted disabled flag in SQLite.
2. An in-memory hook circuit breaker in the server process. Upgrading, enabling the plugin, or recycling its worker does not recreate that breaker.

If server logs show `hasOrchestrator:true` and include this plugin in the chain but return the original URL in the same millisecond without running the hook, inspect `plugin-audit/hooks.ndjson` under the user-data directory for `chain.skip` / `breaker_open`. Restarting the Motrix server process clears the in-memory breaker; refreshing the Web page does not.

For a Docker Compose service named `server`:

```bash
docker compose restart server
```

If the persisted disabled flag also needs repair, stop Motrix first and run the source script against the original ID. The script backs up the database:

```bash
node scripts/reset-plugin-state.mjs --inspect
node scripts/reset-plugin-state.mjs --db "/path/to/motrix.db"
```

This repairs SQLite state; it cannot clear memory in a separately running Motrix process.

`shutting down resolver` can also result from the default five-minute idle recycling and does not itself mean disabled. The plugin catches its own resolution failures, but host permission/patch validation after the hook returns can still trigger the circuit breaker. Grant the manifest's requested permissions.

## Development and verification

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run validate
npm run lint
npm run pack
npm run smoke:packed
npm run live-check
```

Unit tests, mocked-host tests, and packed-bundle smoke tests do not replace end-to-end Web/NAS verification. The behavioral change in 1.3.5 is title-based naming; it adds neither Web mux wiring nor automatic all-part scheduling.

Bangumi, live streams, courses, paid content, and DRM are unsupported. Bilibili APIs and available quality can change.

### Reproducible standalone Build

Use Node.js 24 LTS (minimum 22.16) and npm. Clone this repository and run the commands above from its root. The SDK API, CLI, and manifest-schema archives are included in `vendor/sdk`; the lockfile pins their integrity. No adjacent checkout, global Motrix CLI, or npm publication is required. The SDK is the `2.3.0-media.1` media-protocol variant from the companion fork; upstream SDK code is MIT licensed, with license files inside the archives.

The **Build** workflow runs on pushes, pull requests, and manual dispatch. It uses `npm ci`, typechecks, unit tests with one worker, validates, bundles, lints, packs, and smoke-tests the packed bundle. Node memory is capped at 1536 MiB. Download `bilibili-resolver-1.3.5-<commit>` from a successful run's **Artifacts** section; unpack it to obtain `community.bilibili-resolver-1.3.5.moext` and `SHA256SUMS`, then run `sha256sum -c SHA256SUMS` in that directory. Import the `.moext` into Motrix. GitHub may require sign-in for artifact downloads. Builds do not publish to npm or create release tags. Live checks are optional network checks and are not run in CI.

## License

MIT. Not affiliated with Bilibili.
