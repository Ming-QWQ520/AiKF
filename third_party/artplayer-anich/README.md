# ArtPlayer Anich Edition (vendored)

This folder ships a precompiled build of the ArtPlayer Anich Edition
that AiKF depends on. It is updated automatically by the
`ArtPlayer` repo's GitHub Actions workflow on every push to its `WIP`
branch.

## Source
- Upstream repo: https://github.com/Ming-QWQ520/ArtPlayer
- Branch: `WIP`
- Workflow: `.github/workflows/build-wip.yml`
- Release tag: `anich-edition-wip`
- Release asset: https://github.com/Ming-QWQ520/ArtPlayer/releases/download/anich-edition-wip/anichsdk.zip

## To refresh this folder
```bash
# 1. Fetch the freshly built zip from GitHub Releases
curl -L -o /tmp/anichsdk.zip \
  https://github.com/Ming-QWQ520/ArtPlayer/releases/download/anich-edition-wip/anichsdk.zip

# 2. Wipe this folder's dist/ and types/ and re-extract
rm -rf dist types
mkdir -p dist types
unzip -o /tmp/anichsdk.zip -d /tmp/anichsdk_extracted
mv /tmp/anichsdk_extracted/artplayer.* dist/
mv /tmp/anichsdk_extracted/*.d.ts types/

# 3. Bump the version in package.json to match the upstream version
#    (found inside the zip's package.artplayer.json)
```

## What's bundled
- `dist/artplayer.js` — UMD, es2020, terser-minified
- `dist/artplayer.mjs` — ESM, es2020
- `dist/artplayer.legacy.js` — UMD, es2015
- `types/artplayer.d.ts` — main types (Artplayer class)
- `types/option.d.ts` — Option interface (includes `blankSlate` + `anichTheme`)
- `types/player.d.ts` — Player interface (includes `runCustomTypeDispose`)
- `types/events.d.ts` — Events map (includes `customtype:destroy` + `anich:next-episode`)
- `types/anich.d.ts` — `Artplayer.anich` namespace types
- `types/presets.d.ts` — `Artplayer.presets` namespace types

## AiKF usage
```ts
import Artplayer from 'artplayer'

// 1. Decode Anich playback URLs (no need for a hand-rolled wire.ts)
const url = Artplayer.anich.decodePlaybackURL(rawURL)

// 2. Parse Anich protobuf responses
const vod = Artplayer.anich.parseVOD(bytes)
const page = Artplayer.anich.parseDanmakuPage(danmakuBytes)

// 3. Use the Anich preset (replaces ~120 lines of PlayerDialog.vue config)
const preset = Artplayer.presets.anich({
  container: el,
  url,
  type: isHls ? 'm3u8' : '',
  m3u8Loader: (video, src) => {
    const hls = new Hls()
    hls.loadSource(src); hls.attachMedia(video)
    return hls  // ArtPlayer will call .destroy() on source switch
  },
  danmakuItems: Artplayer.presets.toDanmukuItems(page.items),
  plugins: [
    artplayerPluginDanmuku({ ... }),
    artplayerPluginAutoThumbnail({ ... }),
  ],
})
const art = new Artplayer(preset)

art.on('anich:next-episode', () => { /* host switches episode */ })
```
