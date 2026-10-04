# Chromecast Emulator Demo 🚀

This is an example of how to develop and test a Chromecast sender and receiver locally, without a
Chromecast device!

The sender page uses the real, unmodified [Cast Web Sender SDK](https://developers.google.com/cast/docs/web_sender),
and the receiver page uses the real, unmodified [Cast Web Receiver SDK (CAF)](https://developers.google.com/cast/docs/web_receiver).
Clicking the cast button on the sender opens the receiver in a popup window, and the two SDKs talk
to each other as if the receiver ran on a Chromecast.

## Tech Stack

- [Svelte 5/SvelteKit](https://svelte.dev/) with TypeScript and Prettier
- [Google Cast SDKs](https://developers.google.com/cast/docs/overview)

## How to Use

Build the emulator and run the SvelteKit dev server from the repository root:

```bash
pnpm dev
```

1. Open the sender page at `http://localhost:<port>/sender`.
1. Click the cast button at the top. The receiver page opens in a popup window, and the cast button
   turns green once the session is connected. Allow pop-ups for localhost if Chrome blocks it.
1. Pick a load request template, or write your own, and click "Send Load Request".
1. If a "Click to allow media playback" bar shows up in the receiver window, click it once (see
   [Troubleshooting](../emulator/README.md#troubleshooting)).
1. Control playback from the mini controller.

### Sender Page

The sender page is a regular Cast Web Sender app:

- The cast button is the SDK's `<google-cast-launcher>`, and `CastContext` is set up with the
  [Default Media Receiver](https://developers.google.com/cast/docs/web_receiver#default_media_web_receiver)
  application ID. The emulator opens the local receiver page for any application ID.
- "Send Load Request" builds a `chrome.cast.media.LoadRequest` from the JSON in the editor (in the
  format of a [`LOAD` message](https://developers.google.com/cast/docs/media/messages)) and sends
  it with `CastSession#loadMedia()`.
- The mini controller uses `RemotePlayer` and `RemotePlayerController`:

Controls | &nbsp;
-- | -- |
**Metadata** | The title, subtitle and poster image of the current media.
**Seek Bar** | The current time and duration of the media. Drag to seek.
**Basic Controls** | Play, pause and stop, previous/next queue item, and skip 10 seconds back or forward.
**Volume Controls** | Mute toggle and volume slider. These control the (emulated) device volume.

Reloading the sender page rejoins the running session, just like with a real Chromecast.

### Receiver Page

A basic CAF receiver with a `<cast-media-player>`.

## How it Works

The pages use the scripts from the [`@mattiasbuelens/chromecast-emulator`](../emulator) package in
this workspace. They import the scripts' URLs with Vite's `?url` suffix, and load them one by one
with [`loadScript.ts`](./src/lib/loadScript.ts), before the Cast SDKs. See the
[emulator's README](../emulator/README.md) for how the emulator works, how to use it with your own
apps, and troubleshooting.

## End-to-end Tests

[`tests/cast.test.ts`](./tests/cast.test.ts) drives the sender and the receiver together with
[Playwright](https://playwright.dev/): it opens the sender page, clicks the cast button, picks up
the receiver popup with `page.waitForEvent('popup')`, sends a load request and pauses from the
sender, and checks the result on both sides (the receiver's `<video>`, and the sender SDK's media
session). Both pages use the real Cast SDKs, so the tests need access to `www.gstatic.com`. The
media comes from [`tests/fixtures`](./tests/fixtures), served with `context.route()`.

```bash
pnpm --filter chromecast-emulator-demo exec playwright install chromium  # once
pnpm test:e2e
```

`pnpm test:e2e` builds the emulator, then Playwright starts the dev server on port 4173 and launches
Chromium with `--autoplay-policy=no-user-gesture-required`, so the receiver plays without a click. Set
`CHROMIUM_PATH` to use a Chromium that is already installed, and `CHROMIUM_ARGS` to pass extra
command line flags.

To test your own sender or receiver, write tests the same way (see
[End-to-end Tests](../emulator/README.md#end-to-end-tests) in the emulator's README).

## Troubleshooting

See [Troubleshooting](../emulator/README.md#troubleshooting) in the emulator's README. In short:
if a "Click to allow media playback" bar shows up in the receiver window, click it once.

## Resources

- [Google Cast - CaC Tool](https://casttool.appspot.com/cactool/)
- [UI SVG Set](https://www.svgrepo.com/collection/solar-broken-line-icons)

<img src="./static/idle-icon.png" height=120>
