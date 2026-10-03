/**
 * Window-based Presentation API polyfill.
 *
 * Replaces the browser's Presentation API (https://w3c.github.io/presentation-api/)
 * with one that "presents" by opening the presentation URL in a new window and
 * exchanging messages with it through postMessage().
 *
 * Load this script in both pages, before anything that uses the Presentation API:
 *
 * - Controlling page: `PresentationRequest#start()` opens the URL in a popup window,
 *   and resolves with a `PresentationConnection` to it.
 * - Receiving page (the popup): `navigator.presentation.receiver.connectionList`
 *   resolves with the incoming connections from the opener window.
 *
 * Presentation URLs that are not plain http(s) URLs (such as `cast:` URLs) can be
 * mapped to a page URL with `presentationPolyfill.addUrlResolver()`.
 */
;(function () {
	'use strict'

	if (window.presentationPolyfill) return

	// Every message we post carries this key, so we can ignore unrelated postMessage() traffic.
	const MESSAGE_KEY = '__presentationPolyfill'
	// The receiving window's name starts with this prefix, followed by the presentation ID.
	// The name survives reloads, so the receiving page can always tell it is a presentation.
	const WINDOW_NAME_PREFIX = '__presentation__:'
	const WINDOW_FEATURES = 'popup,width=1280,height=720'
	const CLOSED_WINDOW_POLL_MS = 500
	const RECEIVER_HEARTBEAT_MS = 1000
	const RECEIVER_DISCOVERY_TIMEOUT_MS = 2 * RECEIVER_HEARTBEAT_MS + 500
	const LOG_PREFIX = '[presentation-polyfill]'

	const NativePresentation = navigator.presentation

	// ----------- Helpers

	const randomId = () =>
		typeof crypto !== 'undefined' && crypto.randomUUID
			? crypto.randomUUID()
			: Date.now().toString(36) + Math.random().toString(36).slice(2)

	const domException = (name, message) => new DOMException(message || name, name)

	const post = (target, type, payload) => {
		// The receiving page may live on another origin, so we cannot restrict the target origin.
		// Both sides verify event.source instead.
		target.postMessage({ [MESSAGE_KEY]: type, ...payload }, '*')
	}

	const defineEventHandlers = (proto, names) => {
		for (const name of names) {
			const key = Symbol(`on${name}`)
			Object.defineProperty(proto, `on${name}`, {
				configurable: true,
				enumerable: true,
				get() {
					return this[key] || null
				},
				set(handler) {
					if (this[key]) this.removeEventListener(name, this[key])
					this[key] = typeof handler === 'function' ? handler : null
					if (this[key]) this.addEventListener(name, this[key])
				}
			})
		}
	}

	const urlResolvers = []
	const idGenerators = []
	const reconnectResolvers = []

	/** Pick the ID for a new presentation of the given presentation URL. */
	const createPresentationId = (presentationUrl) => {
		for (const generator of idGenerators) {
			const id = generator(presentationUrl)
			if (id) return id
		}
		return randomId()
	}

	/** Map a presentation URL to the URL of the page to open, or null if unsupported. */
	const resolvePageUrl = (presentationUrl) => {
		for (const resolver of urlResolvers) {
			const resolved = resolver(presentationUrl)
			if (resolved) return resolved
		}
		const { protocol } = new URL(presentationUrl)
		return protocol === 'http:' || protocol === 'https:' ? presentationUrl : null
	}

	// ----------- Events

	class PresentationConnectionAvailableEvent extends Event {
		constructor(type, init) {
			super(type, init)
			this.connection = init.connection
		}
	}

	class PresentationConnectionCloseEvent extends Event {
		constructor(type, init) {
			super(type, init)
			this.reason = init.reason
			this.message = init.message || ''
		}
	}

	// ----------- PresentationConnection

	const transportKey = Symbol('transport')

	class PresentationConnection extends EventTarget {
		constructor(id, url, transport) {
			super()
			this.id = id
			this.url = url
			this.state = 'connecting'
			this.binaryType = 'arraybuffer'
			this[transportKey] = transport
		}

		send(data) {
			if (this.state !== 'connected') {
				throw domException('InvalidStateError', `Connection is ${this.state}`)
			}
			this[transportKey].send(data)
		}

		close() {
			if (this.state !== 'connecting' && this.state !== 'connected') return
			this[transportKey].close('closed', '')
			_closed(this, 'closed', '')
		}

		terminate() {
			if (this.state === 'terminated') return
			this[transportKey].terminate()
		}
	}
	defineEventHandlers(PresentationConnection.prototype, ['connect', 'close', 'terminate', 'message'])

	const _connected = (connection) => {
		if (connection.state !== 'connecting') return
		connection.state = 'connected'
		connection.dispatchEvent(new Event('connect'))
	}

	const _closed = (connection, reason, message) => {
		if (connection.state !== 'connecting' && connection.state !== 'connected') return
		connection.state = 'closed'
		connection.dispatchEvent(new PresentationConnectionCloseEvent('close', { reason, message }))
	}

	const _terminated = (connection) => {
		if (connection.state === 'terminated') return
		connection.state = 'terminated'
		connection.dispatchEvent(new Event('terminate'))
	}

	const _received = (connection, data) => {
		if (connection.state !== 'connected') return
		if (data instanceof ArrayBuffer && connection.binaryType === 'blob') data = new Blob([data])
		connection.dispatchEvent(new MessageEvent('message', { data }))
	}

	const toTransferable = (data) => {
		if (typeof data === 'string' || data instanceof Blob || data instanceof ArrayBuffer) return data
		if (ArrayBuffer.isView(data)) {
			return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
		}
		throw new TypeError('Unsupported message type')
	}

	// ----------- Controlling side

	/**
	 * Presentations started (or rediscovered) by this page, by presentation ID.
	 * @type {Map<string, {id: string, url: string, window: Window, connections: Map<string, PresentationConnection>, receiverReady: boolean, onReceiverReady: Array<() => void>}>}
	 */
	const presentations = new Map()

	const getOrCreatePresentation = (id, url, win) => {
		let presentation = presentations.get(id)
		if (!presentation) {
			presentation = {
				id,
				url,
				window: win,
				connections: new Map(),
				receiverReady: false,
				onReceiverReady: []
			}
			presentations.set(id, presentation)
			watchForClosedWindow(presentation)
		}
		return presentation
	}

	const watchForClosedWindow = (presentation) => {
		const timer = setInterval(() => {
			if (presentation.window.closed) {
				clearInterval(timer)
				terminatePresentation(presentation)
			}
		}, CLOSED_WINDOW_POLL_MS)
	}

	const terminatePresentation = (presentation) => {
		presentations.delete(presentation.id)
		for (const connection of presentation.connections.values()) _terminated(connection)
		presentation.connections.clear()
	}

	const whenReceiverReady = (presentation, timeoutMs) =>
		new Promise((resolve, reject) => {
			if (presentation.receiverReady) return resolve()
			presentation.onReceiverReady.push(resolve)
			if (timeoutMs) {
				setTimeout(() => reject(domException('NotFoundError', 'Receiver did not respond')), timeoutMs)
			}
		})

	/** Create a controlling connection to a receiving window, and ask the receiver to accept it. */
	const connectToPresentation = (presentation, url, { reconnect }) => {
		const connectionId = randomId()
		const connection = new PresentationConnection(presentation.id, url, {
			send(data) {
				post(presentation.window, 'message', { connectionId, data: toTransferable(data) })
			},
			close(reason, message) {
				presentation.connections.delete(connectionId)
				post(presentation.window, 'close', { connectionId, reason, message })
			},
			terminate() {
				post(presentation.window, 'terminate', { connectionId })
				presentation.window.close()
				terminatePresentation(presentation)
			}
		})
		presentation.connections.set(connectionId, connection)
		post(presentation.window, 'connect', {
			connectionId,
			presentationId: presentation.id,
			url,
			reconnect,
			userAgent: navigator.userAgent
		})
		return connection
	}

	const findPresentationBySource = (source) => {
		for (const presentation of presentations.values()) {
			if (presentation.window === source) return presentation
		}
		return null
	}

	window.addEventListener('message', (event) => {
		const data = event.data
		if (!data || typeof data !== 'object' || !(MESSAGE_KEY in data)) return
		const type = data[MESSAGE_KEY]

		// Heartbeats let a reloaded controlling page find receivers it opened before the reload.
		if (type === 'receiver-hello' || type === 'receiver-alive') {
			if (!event.source || !data.presentationId) return
			const presentation = getOrCreatePresentation(data.presentationId, data.url, event.source)
			if (presentation.window !== event.source) return
			if (!presentation.receiverReady) {
				presentation.receiverReady = true
				presentation.onReceiverReady.splice(0).forEach((resolve) => resolve())
			}
			return
		}

		const presentation = findPresentationBySource(event.source)
		if (!presentation) return
		const connection = presentation.connections.get(data.connectionId)

		switch (type) {
			case 'connected':
				if (connection) _connected(connection)
				break
			case 'message':
				if (connection) _received(connection, data.data)
				break
			case 'close':
				if (connection) {
					presentation.connections.delete(data.connectionId)
					_closed(connection, data.reason || 'closed', data.message)
				}
				break
			case 'terminated':
				terminatePresentation(presentation)
				break
		}
	})

	window.addEventListener('pagehide', () => {
		for (const presentation of presentations.values()) {
			for (const [connectionId, connection] of presentation.connections) {
				if (connection.state === 'connected' || connection.state === 'connecting') {
					post(presentation.window, 'close', { connectionId, reason: 'wentaway', message: '' })
				}
			}
		}
	})

	class PresentationAvailability extends EventTarget {
		constructor(value) {
			super()
			this.value = value
		}
	}
	defineEventHandlers(PresentationAvailability.prototype, ['change'])

	const availabilityKey = Symbol('availability')

	class PresentationRequest extends EventTarget {
		constructor(urls) {
			super()
			const list = Array.isArray(urls) ? urls : [urls]
			if (list.length === 0) throw domException('NotSupportedError', 'No presentation URLs')
			this.urls = list.map((url) => {
				try {
					return new URL(url, document.baseURI).href
				} catch {
					throw new DOMException(`Invalid presentation URL: ${url}`, 'SyntaxError')
				}
			})
		}

		/** Pick the first presentation URL we know how to open. */
		_selectUrl() {
			for (const url of this.urls) {
				const pageUrl = resolvePageUrl(url)
				if (pageUrl) return { url, pageUrl }
			}
			return null
		}

		start() {
			const selected = this._selectUrl()
			if (!selected) {
				return Promise.reject(domException('NotFoundError', 'No available presentation display'))
			}
			// Open the window synchronously, so it still counts as part of the user gesture.
			const presentationId = createPresentationId(selected.url)
			const win = window.open(selected.pageUrl, WINDOW_NAME_PREFIX + presentationId, WINDOW_FEATURES)
			if (!win) {
				return Promise.reject(
					domException('NotAllowedError', 'Could not open the presentation window (pop-up blocked?)')
				)
			}
			const presentation = getOrCreatePresentation(presentationId, selected.url, win)
			return whenReceiverReady(presentation).then(() => {
				const connection = connectToPresentation(presentation, selected.url, { reconnect: false })
				this._fireConnectionAvailable(connection)
				return connection
			})
		}

		reconnect(requestedId) {
			// Map special presentation IDs (like the Cast SDK's "auto-join") to a known presentation.
			const resolveId = () => {
				if (presentations.has(requestedId)) return requestedId
				const known = [...presentations.values()]
					.filter((p) => !p.window.closed)
					.map(({ id, url }) => ({ id, url }))
				for (const resolver of reconnectResolvers) {
					const id = resolver(requestedId, this.urls, known)
					if (id && presentations.has(id)) return id
				}
				return requestedId
			}
			let presentationId = resolveId()
			const live = () => {
				const presentation = presentations.get(presentationId)
				if (!presentation || presentation.window.closed) return null
				// Reuse an existing connection to this presentation, as the spec says.
				for (const connection of presentation.connections.values()) {
					if (connection.state === 'connecting' || connection.state === 'connected') return connection
				}
				return presentation
			}
			const found = live()
			if (found instanceof PresentationConnection) return Promise.resolve(found)

			const wait = found
				? whenReceiverReady(found, RECEIVER_DISCOVERY_TIMEOUT_MS)
				: new Promise((resolve, reject) => {
						// After a reload, we only learn about the receiver from its next heartbeat.
						const started = Date.now()
						const poll = setInterval(() => {
							presentationId = resolveId()
							if (presentations.has(presentationId)) {
								clearInterval(poll)
								resolve()
							} else if (Date.now() - started > RECEIVER_DISCOVERY_TIMEOUT_MS) {
								clearInterval(poll)
								reject(domException('NotFoundError', `No presentation with ID ${presentationId}`))
							}
						}, 100)
					})

			return wait.then(() => {
				const presentation = presentations.get(presentationId)
				if (!presentation || presentation.window.closed) {
					throw domException('NotFoundError', `No presentation with ID ${presentationId}`)
				}
				const url = this._selectUrl()?.url || presentation.url
				const connection = connectToPresentation(presentation, url, { reconnect: true })
				this._fireConnectionAvailable(connection)
				return connection
			})
		}

		getAvailability() {
			if (!this[availabilityKey]) {
				this[availabilityKey] = Promise.resolve(new PresentationAvailability(!!this._selectUrl()))
			}
			return this[availabilityKey]
		}

		_fireConnectionAvailable(connection) {
			setTimeout(() =>
				this.dispatchEvent(new PresentationConnectionAvailableEvent('connectionavailable', { connection }))
			)
		}
	}
	defineEventHandlers(PresentationRequest.prototype, ['connectionavailable'])

	// ----------- Receiving side

	class PresentationConnectionList extends EventTarget {
		constructor() {
			super()
			this._connections = []
		}

		get connections() {
			return this._connections.filter((c) => c.state === 'connected' || c.state === 'connecting')
		}
	}
	defineEventHandlers(PresentationConnectionList.prototype, ['connectionavailable'])

	class PresentationReceiver {
		constructor(connectionList) {
			this._connectionList = connectionList
			this._listReady = new Promise((resolve) => (this._resolveList = resolve))
		}

		get connectionList() {
			return this._listReady
		}
	}

	const createReceiver = () => {
		const presentationId = window.name.slice(WINDOW_NAME_PREFIX.length)
		const controller = window.opener
		const list = new PresentationConnectionList()
		const receiver = new PresentationReceiver(list)
		/** @type {Map<string, PresentationConnection>} */
		const connections = new Map()
		let presentationUrl = null

		const sendTerminated = () => post(controller, 'terminated', {})

		window.addEventListener('message', (event) => {
			const data = event.data
			if (event.source !== controller) return
			if (!data || typeof data !== 'object' || !(MESSAGE_KEY in data)) return
			const { connectionId } = data

			switch (data[MESSAGE_KEY]) {
				case 'connect': {
					if (connections.has(connectionId)) return
					presentationUrl = presentationUrl || data.url
					const connection = new PresentationConnection(presentationId, data.url, {
						send(message) {
							post(controller, 'message', { connectionId, data: toTransferable(message) })
						},
						close(reason, message) {
							post(controller, 'close', { connectionId, reason, message })
						},
						terminate() {
							for (const c of connections.values()) _terminated(c)
							sendTerminated()
							window.close()
						}
					})
					// Not part of the spec: lets receiver-side code tell new sessions from reconnects.
					Object.defineProperty(connection, 'polyfillInfo', {
						value: Object.freeze({ reconnect: !!data.reconnect, userAgent: data.userAgent || '' })
					})
					connections.set(connectionId, connection)
					list._connections.push(connection)
					_connected(connection)
					post(controller, 'connected', { connectionId })
					receiver._resolveList(list)
					list.dispatchEvent(new PresentationConnectionAvailableEvent('connectionavailable', { connection }))
					break
				}
				case 'message': {
					const connection = connections.get(connectionId)
					if (connection) _received(connection, data.data)
					break
				}
				case 'close': {
					const connection = connections.get(connectionId)
					if (connection) {
						connections.delete(connectionId)
						_closed(connection, data.reason || 'closed', data.message)
					}
					break
				}
				case 'terminate':
					for (const c of connections.values()) _terminated(c)
					connections.clear()
					window.close()
					break
			}
		})

		const hello = (type) => post(controller, type, { presentationId, url: presentationUrl })
		hello('receiver-hello')
		setInterval(() => {
			if (!controller.closed) hello('receiver-alive')
		}, RECEIVER_HEARTBEAT_MS)
		window.addEventListener('pagehide', sendTerminated)

		return receiver
	}

	// ----------- Install

	const isReceivingWindow = window.name.startsWith(WINDOW_NAME_PREFIX) && !!window.opener

	let defaultRequest = null
	const presentation = {
		get defaultRequest() {
			return defaultRequest
		},
		set defaultRequest(request) {
			defaultRequest = request instanceof PresentationRequest ? request : null
		},
		receiver: isReceivingWindow ? createReceiver() : null
	}

	Object.defineProperty(navigator, 'presentation', {
		configurable: true,
		enumerable: true,
		get: () => presentation
	})

	Object.assign(window, {
		PresentationRequest,
		PresentationAvailability,
		PresentationConnection,
		PresentationConnectionAvailableEvent,
		PresentationConnectionCloseEvent,
		PresentationReceiver,
		PresentationConnectionList
	})

	window.presentationPolyfill = {
		/**
		 * Register a function that maps a presentation URL to the URL of the page to open
		 * for it, or returns null when it does not handle that URL.
		 * @param {(presentationUrl: string) => string | null} resolver
		 */
		addUrlResolver(resolver) {
			urlResolvers.push(resolver)
		},
		/**
		 * Register a function that picks the ID for a new presentation of a presentation URL,
		 * or returns null to leave it to the next one (or a random ID).
		 * @param {(presentationUrl: string) => string | null} generator
		 */
		addPresentationIdGenerator(generator) {
			idGenerators.push(generator)
		},
		/**
		 * Register a function that maps the ID passed to `PresentationRequest#reconnect()` to the ID
		 * of a known presentation, or returns null when it does not handle that ID.
		 * @param {(requestedId: string, requestUrls: string[], known: Array<{id: string, url: string | null}>) => string | null} resolver
		 */
		addReconnectResolver(resolver) {
			reconnectResolvers.push(resolver)
		},
		isReceivingWindow,
		nativePresentation: NativePresentation
	}

	console.debug(LOG_PREFIX, isReceivingWindow ? 'installed (receiving window)' : 'installed')
})()
