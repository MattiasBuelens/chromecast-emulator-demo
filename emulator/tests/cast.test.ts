import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// The tests serve their own media, so they don't depend on (or download) real content.
const MEDIA_URL = 'https://media.test/test-video.webm'
const MEDIA_FILE = new URL('./fixtures/test-video.webm', import.meta.url)

const LOAD_REQUEST = {
	type: 'LOAD',
	media: {
		contentUrl: MEDIA_URL,
		contentType: 'video/webm',
		streamType: 'BUFFERED',
		metadata: { metadataType: 0, title: 'Test Pattern', subtitle: 'End-to-end test' }
	}
}

/** The state of the `<video>` that `<cast-media-player>` plays media in. */
const getReceiverVideo = (receiver: Page) =>
	receiver.evaluate(() => {
		const video = document.querySelector('cast-media-player')?.shadowRoot?.querySelector('video')
		return video && { src: video.currentSrc, paused: video.paused, currentTime: video.currentTime }
	})

/** The state of the Cast session and its media, as the sender SDK sees it. */
const getSenderPlayer = (sender: Page) =>
	sender.evaluate(() => {
		const session = cast.framework.CastContext.getInstance().getCurrentSession()
		const media = session?.getMediaSession()
		return {
			sessionState: cast.framework.CastContext.getInstance().getSessionState(),
			contentId: media?.media?.contentId,
			playerState: media?.playerState
		}
	})

test.beforeEach(async ({ context }) => {
	const body = await readFile(MEDIA_FILE)
	// context.route() also covers the receiver popup.
	await context.route(MEDIA_URL, (route) =>
		route.fulfill({
			body,
			contentType: 'video/webm',
			headers: { 'Access-Control-Allow-Origin': '*' }
		})
	)
})

test('casts and controls media from the sender to the receiver', async ({ page: sender }) => {
	await sender.goto('/sender')

	// Cast: the emulator opens the receiver page in a popup.
	// Wait for the Cast SDK to find the (emulated) receiver, before clicking the cast button.
	await sender.waitForFunction(
		() => window.cast?.framework?.CastContext.getInstance().getCastState() === 'NOT_CONNECTED'
	)
	const [receiver] = await Promise.all([
		sender.waitForEvent('popup'),
		sender.locator('google-cast-launcher').click()
	])
	await expect(receiver).toHaveURL(/\/receiver$/)
	await expect(sender.getByText(/^Casting to /)).toBeVisible()
	await expect(receiver.locator('cast-media-player')).toBeAttached()

	// Load media from the sender.
	await sender.locator('.load-request-input__input').fill(JSON.stringify(LOAD_REQUEST))
	await sender.getByRole('button', { name: 'Send Load Request' }).click()

	// The receiver plays it...
	await expect
		.poll(() => getReceiverVideo(receiver))
		.toMatchObject({ src: MEDIA_URL, paused: false })
	await expect.poll(async () => (await getReceiverVideo(receiver))?.currentTime).toBeGreaterThan(1)
	// ...and the sender sees it playing.
	await expect
		.poll(() => getSenderPlayer(sender))
		.toEqual({ sessionState: 'SESSION_STARTED', contentId: MEDIA_URL, playerState: 'PLAYING' })
	await expect(sender.getByRole('heading', { name: 'Test Pattern' })).toBeVisible()

	// Pause from the sender's mini controller.
	await sender.getByRole('button', { name: 'Pause' }).click()
	await expect.poll(async () => (await getReceiverVideo(receiver))?.paused).toBe(true)
	await expect.poll(async () => (await getSenderPlayer(sender)).playerState).toBe('PAUSED')

	// Stop casting: the receiver closes its window.
	await sender.evaluate(() => cast.framework.CastContext.getInstance().endCurrentSession(true))
	await expect.poll(() => receiver.isClosed()).toBe(true)
	await expect(sender.getByText('Cast Locally')).toBeVisible()
})
