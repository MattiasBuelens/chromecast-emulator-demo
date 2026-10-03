/**
 * Cast sender emulator.
 *
 * Lets an unmodified Cast Web Sender SDK app cast to a local receiver page in a new window.
 *
 * In Chrome, the Cast Web Sender SDK talks to Cast devices through the Presentation API,
 * using `cast:<appId>?clientId=...` presentation URLs. Together with presentation-polyfill.js,
 * this script makes those requests open a receiver page in a popup window instead. That
 * receiver page must load presentation-polyfill.js and cast-receiver-emulator.js.
 *
 * Load order, before cast_sender.js:
 *
 *     <script src="/presentation-polyfill.js"></script>
 *     <script src="/cast-sender-emulator.js" data-receiver-url="/receiver"></script>
 *     <script src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"></script>
 *
 * `data-receiver-url` is the receiver page for every app ID. To pick a page per app ID, set
 * `window.castEmulatorConfig = { receivers: { '<appId>': '<url>' }, receiverUrl: '<fallback>' }`
 * before loading this script.
 */
;(function () {
	'use strict'

	const LOG_PREFIX = '[cast-sender-emulator]'

	if (!window.presentationPolyfill) {
		console.error(LOG_PREFIX, 'presentation-polyfill.js must be loaded first')
		return
	}

	const script = document.currentScript
	const config = {
		receiverUrl: script?.dataset.receiverUrl || null,
		receivers: {},
		...window.castEmulatorConfig
	}

	/**
	 * Parse a Cast presentation URL, in either of the forms Chrome accepts:
	 * - `cast:<appId>?clientId=...&autoJoinPolicy=...`
	 * - `https://google.com/cast#__castAppId__=<appId>/__castClientId__=...` (legacy)
	 * @returns {{appIds: string[], clientId: string} | null}
	 */
	const parseCastUrl = (presentationUrl) => {
		const url = new URL(presentationUrl)
		if (url.protocol === 'cast:') {
			const appId = url.pathname
			return appId ? { appIds: [appId], clientId: url.searchParams.get('clientId') || '' } : null
		}
		if (/^https?:$/.test(url.protocol) && url.hostname === 'google.com' && url.pathname === '/cast') {
			const params = url.hash
				.slice(1)
				.split('/')
				.map((pair) => pair.split('='))
				.map(([key, value = '']) => [key, decodeURIComponent(value.replace(/\+/g, ' '))])
			const appIds = params
				.filter(([key]) => key === '__castAppId__')
				.map(([, value]) => value.replace(/\(.*$/, '')) // strip "(capabilities)"
				.filter(Boolean)
			const clientId = params.find(([key]) => key === '__castClientId__')?.[1] || ''
			return appIds.length ? { appIds, clientId } : null
		}
		return null
	}

	window.presentationPolyfill.addUrlResolver((presentationUrl) => {
		const cast = parseCastUrl(presentationUrl)
		if (!cast) return null
		for (const appId of cast.appIds) {
			const receiverUrl = config.receivers[appId] || config.receiverUrl
			if (receiverUrl) return new URL(receiverUrl, document.baseURI).href
		}
		console.warn(LOG_PREFIX, 'no receiver page configured for app IDs', cast.appIds)
		return null
	})

	// cast_sender.js only uses the Presentation API when it detects Chrome.
	window.chrome = window.chrome || {}

	window.castSenderEmulator = { parseCastUrl, config }
})()
