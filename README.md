# Chromecast Emulator Demo

Cast from an unmodified Cast Web Sender app to an unmodified Cast Web Receiver (CAF) app, both
running in your browser. No Chromecast device, browser extension or WebSocket server needed.

See [emulator/README.md](./emulator/README.md) for how it works and how to use it with your own apps.

## Prerequisites

- Node.js with pnpm (`corepack enable`, or `npx pnpm@9`)
- `pnpm install`

## Scripts

- `pnpm run dev`: runs the emulator demo. Open `/sender` and click the cast button.
- `pnpm run extension`: bundles the extension into the `extension/dist` directory.
