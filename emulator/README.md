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

Run the SvelteKit dev server from the repository root:

```bash
pnpm dev
```

1. Open the sender page at `http://localhost:<port>/sender`.
1. Click the cast button at the top. The receiver page opens in a popup window, and the cast button
   turns green once the session is connected. Allow pop-ups for localhost if Chrome blocks it.
1. Pick a load request template, or write your own, and click "Send Load Request".
1. If a "Click to allow media playback" bar shows up in the receiver window, click it once (see
   [Troubleshooting](#troubleshooting)).
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

In Chrome, the Cast Web Sender SDK uses the [Presentation API](https://w3c.github.io/presentation-api/)
to talk to Cast devices: it starts a presentation of a `cast:<appId>` URL, and exchanges JSON
messages with Chrome's Media Router over the resulting `PresentationConnection`. On the device,
the receiver SDK talks to the Cast platform over a WebSocket to `ws://localhost:8008/v2/ipc`.

The emulator replaces both ends with three scripts in [/static](./static):

- [`presentation-polyfill.js`](./static/presentation-polyfill.js) (sender and receiver): a
  Presentation API implementation that presents a URL by opening it in a popup window, and
  exchanges messages with it through `postMessage()`. The receiver window gets the incoming
  connections through `navigator.presentation.receiver`.
- [`cast-sender-emulator.js`](./static/cast-sender-emulator.js) (sender): maps `cast:<appId>`
  presentation URLs to the receiver page, names presentations after their Cast session, and lets
  the SDK rejoin a session after a reload.
- [`cast-receiver-emulator.js`](./static/cast-receiver-emulator.js) (receiver): fakes the Cast
  platform (`cast.__platform__` and the IPC WebSocket), and plays the part of Chrome's Media Router:
  it translates the sender SDK's messages to the IPC messages CAF expects, and back.

Nothing else needs to change in your sender or receiver code.

## Using Your Own Sender and Receiver

### Sender

Load the polyfill and the sender emulator **before** the Cast Web Sender SDK, and point
`data-receiver-url` at your receiver page:

```html
<script src="/presentation-polyfill.js"></script>
<script src="/cast-sender-emulator.js" data-receiver-url="http://localhost:8080/receiver.html"></script>
<script src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"></script>
```

To open a different receiver page per application ID, set `window.castEmulatorConfig` before
loading `cast-sender-emulator.js`:

```html
<script>
	window.castEmulatorConfig = {
		receivers: { ABCD1234: 'http://localhost:8080/receiver.html' },
		receiverUrl: '/receiver' // for any other application ID
	}
</script>
```

### Receiver

Load the polyfill and the receiver emulator **before** the Cast Web Receiver SDK:

```html
<script src="/presentation-polyfill.js"></script>
<script src="/cast-receiver-emulator.js"></script>
<script src="https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"></script>
```

The receiver page can live on another origin than the sender page.

Only load the emulator scripts during local development. They replace the browser's Presentation
API and the receiver's platform connection, so casting to a real Chromecast won't work with them.

When SvelteKit (or another framework) navigates on the client, scripts in `<svelte:head>` may run
out of order. This demo loads them one by one with [`loadScript.ts`](./src/lib/loadScript.ts).

### Debugging

In the receiver window, `castReceiverEmulator.trace` holds the latest IPC messages between CAF and
the emulated platform, and the messages to and from the sender. They are also logged with
`console.debug()` (enable the "Verbose" log level in DevTools).

## Troubleshooting

### Video loads on the receiver, but does not play

The receiver window opens without a user gesture of its own, so Chrome's
[autoplay policy](https://developer.chrome.com/blog/autoplay/) may block it from playing media
with sound. When that happens, the receiver emulator shows a "Click to allow media playback" bar at
the bottom of the receiver window. Click it (or anywhere in the window) once, and the emulator
starts the blocked media again.

To skip this during development, start Chrome with `--autoplay-policy=no-user-gesture-required`.

### Volume controls change the video volume

A real Chromecast applies its device volume to the audio output. The emulator applies it to the
receiver's `<audio>` and `<video>` elements instead, which overrides the receiver's own stream
volume.

### Known limitations

- Only the sender page that opened the receiver window (and that page after a reload) can join
  its session. Other tabs and other browsers can't.
- While the receiver window covers the sender window, Chrome considers the sender page hidden and
  throttles its timers.

## Resources

- [Presentation API](https://w3c.github.io/presentation-api/)
- [Chromium's Cast Media Route Provider](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/media/router/providers/cast/), which the receiver emulator mimics
- [ajhsu - chromecast-device-emulator](https://github.com/ajhsu/chromecast-device-emulator)
  - [Example IPC Messages](https://github.com/ajhsu/chromecast-device-emulator/blob/master/examples/scenarios/BasicReceiverCAF-sample.json)
- [Google Cast - Main Messages](https://developers.google.com/cast/docs/media/messages)
- [Google Cast - Custom Web Receiver](https://developers.google.com/cast/docs/web_receiver/basic)
- [Google Cast - Custom Web Sender](https://developers.google.com/cast/docs/web_sender)
- [Google Cast - CaC Tool](https://casttool.appspot.com/cactool/)
- [UI SVG Set](https://www.svgrepo.com/collection/solar-broken-line-icons)

<img src="./static/idle-icon.png" height=120>
