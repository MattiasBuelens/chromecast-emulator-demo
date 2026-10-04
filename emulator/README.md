# Chromecast Emulator

Develop and test a Chromecast sender and receiver locally, without a Chromecast device.

With these scripts, an unmodified [Cast Web Sender](https://developers.google.com/cast/docs/web_sender)
app casts to an unmodified [Cast Web Receiver (CAF)](https://developers.google.com/cast/docs/web_receiver)
app running in a popup window of the same browser. The two SDKs talk to each other as if the
receiver ran on a Chromecast. No browser extension or server needed.

## Installation

```bash
npm install --save-dev @mattiasbuelens/chromecast-emulator
```

The package contains three classic (non-module) scripts, each with a minified version:

| Script | Load it in |
| -- | -- |
| `presentation-polyfill.js` | Sender and receiver |
| `cast-sender-emulator.js` | Sender |
| `cast-receiver-emulator.js` | Receiver |

Serve them from `node_modules/@mattiasbuelens/chromecast-emulator/dist/` with your development
server, or load them from a CDN such as
`https://cdn.jsdelivr.net/npm/@mattiasbuelens/chromecast-emulator/dist/presentation-polyfill.js`.
With a bundler like Vite, you can also get their URLs by importing them, for example
`import polyfillUrl from '@mattiasbuelens/chromecast-emulator/presentation-polyfill?url'`
(see the [demo](https://github.com/MattiasBuelens/chromecast-emulator-demo/blob/main/demo/src/routes/sender/+page.svelte)).

### Exports

Each script has three entry points, for example for `presentation-polyfill`:

| Import | Resolves to |
| -- | -- |
| `@mattiasbuelens/chromecast-emulator/presentation-polyfill` | The minified script under the `production` [export condition](https://nodejs.org/api/packages.html#community-conditions-definitions), the readable script otherwise |
| `@mattiasbuelens/chromecast-emulator/presentation-polyfill.js` | Always the readable script |
| `@mattiasbuelens/chromecast-emulator/presentation-polyfill.min.js` | Always the minified script |

Vite and webpack set the `production` condition in production builds. For other tools, pass it
in their conditions option (for example esbuild's `--conditions=production`).

## Usage

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

Clicking the cast button now opens the receiver page in a popup window. Allow pop-ups for your
development server if the browser blocks it. Reloading the sender page rejoins the running
session, just like with a real Chromecast.

### Receiver

Load the polyfill and the receiver emulator **before** the Cast Web Receiver SDK:

```html
<script src="/presentation-polyfill.js"></script>
<script src="/cast-receiver-emulator.js"></script>
<script src="https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"></script>
```

The receiver page can live on another origin than the sender page.

Nothing else needs to change in your sender or receiver code.

Only load the emulator scripts during local development. They replace the browser's Presentation
API and the receiver's platform connection, so casting to a real Chromecast won't work with them.

When a framework inserts these scripts dynamically (for example SvelteKit's `<svelte:head>` on
client-side navigation), they may run out of order. Load them one by one instead, like the demo's
[`loadScript.ts`](https://github.com/MattiasBuelens/chromecast-emulator-demo/blob/main/demo/src/lib/loadScript.ts) does.

## How it Works

In Chrome, the Cast Web Sender SDK uses the [Presentation API](https://w3c.github.io/presentation-api/)
to talk to Cast devices: it starts a presentation of a `cast:<appId>` URL, and exchanges JSON
messages with Chrome's Media Router over the resulting `PresentationConnection`. On the device,
the receiver SDK talks to the Cast platform over a WebSocket to `ws://localhost:8008/v2/ipc`.

The emulator replaces both ends:

- [`presentation-polyfill.js`](https://github.com/MattiasBuelens/chromecast-emulator-demo/blob/main/emulator/src/presentation-polyfill.js) (sender and receiver): a
  Presentation API implementation that presents a URL by opening it in a popup window, and
  exchanges messages with it through `postMessage()`. The receiver window gets the incoming
  connections through `navigator.presentation.receiver`.
- [`cast-sender-emulator.js`](https://github.com/MattiasBuelens/chromecast-emulator-demo/blob/main/emulator/src/cast-sender-emulator.js) (sender): maps `cast:<appId>`
  presentation URLs to the receiver page, names presentations after their Cast session, and lets
  the SDK rejoin a session after a reload.
- [`cast-receiver-emulator.js`](https://github.com/MattiasBuelens/chromecast-emulator-demo/blob/main/emulator/src/cast-receiver-emulator.js) (receiver): fakes the Cast
  platform (`cast.__platform__` and the IPC WebSocket), and plays the part of Chrome's Media Router:
  it translates the sender SDK's messages to the IPC messages CAF expects, and back.

## Debugging

In the receiver window, `castReceiverEmulator.trace` holds the latest IPC messages between CAF and
the emulated platform, and the messages to and from the sender. They are also logged with
`console.debug()` (enable the "Verbose" log level in DevTools).

## End-to-end Tests

The emulator works in browsers driven by test frameworks such as [Playwright](https://playwright.dev/):
`page` is your sender, and the receiver is the popup it opens (`page.waitForEvent('popup')`).
Use `context.route()` rather than `page.route()`, so routes also cover the popup. Launch Chromium
with `--autoplay-policy=no-user-gesture-required`, so the receiver plays media without a click.
See the demo's [test](https://github.com/MattiasBuelens/chromecast-emulator-demo/blob/main/demo/tests/cast.test.ts) for a complete example.

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

## Development

The scripts in [`src`](https://github.com/MattiasBuelens/chromecast-emulator-demo/tree/main/emulator/src) are published as they are. `pnpm build` copies them to `dist/` and
adds a minified version of each, and runs automatically before `npm publish`.

## Resources

- [Presentation API](https://w3c.github.io/presentation-api/)
- [Chromium's Cast Media Route Provider](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/media/router/providers/cast/), which the receiver emulator mimics
- [ajhsu - chromecast-device-emulator](https://github.com/ajhsu/chromecast-device-emulator)
  - [Example IPC Messages](https://github.com/ajhsu/chromecast-device-emulator/blob/master/examples/scenarios/BasicReceiverCAF-sample.json)
- [Google Cast - Main Messages](https://developers.google.com/cast/docs/media/messages)
- [Google Cast - Custom Web Receiver](https://developers.google.com/cast/docs/web_receiver/basic)
- [Google Cast - Custom Web Sender](https://developers.google.com/cast/docs/web_sender)
