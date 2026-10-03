/**
 * Cast receiver emulator.
 *
 * Lets an unmodified Cast Web Receiver (CAF) app run in a normal browser window, controlled by
 * a Cast sender app in its opener window (see cast-sender-emulator.js).
 *
 * On a real Cast device, the receiver SDK exchanges "IPC" messages with the device's platform over
 * a WebSocket to ws://localhost:8008/v2/ipc, and Chrome's Media Router translates between the
 * sender SDK and the Cast protocol. This script plays both of those parts inside the receiver page:
 *
 * - It fakes `cast.__platform__`, so the receiver SDK believes it runs on a Cast device.
 * - It replaces the IPC WebSocket with an in-page object.
 * - It accepts the sender SDK's Presentation API connections from
 *   `navigator.presentation.receiver` (provided by presentation-polyfill.js), and translates
 *   their messages to and from the IPC messages the receiver SDK expects.
 *
 * Load order, before the receiver SDK:
 *
 *     <script src="/presentation-polyfill.js"></script>
 *     <script src="/cast-receiver-emulator.js"></script>
 *     <script src="//www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"></script>
 *
 * For debugging, `castReceiverEmulator.trace` holds the most recent IPC and sender messages, and
 * every message is also logged with console.debug() (shown with the "Verbose" log level).
 */
;(function () {
	'use strict'

	const LOG_PREFIX = '[cast-receiver-emulator]'
	const IPC_PORT = 8008

	const SYSTEM_NAMESPACE = 'urn:x-cast:com.google.cast.system'
	const MEDIA_NAMESPACE = 'urn:x-cast:com.google.cast.media'
	const SYSTEM_SENDER_ID = 'SystemSender'
	const RESERVED_NAMESPACE_PREFIX = 'urn:x-cast:com.google.cast.'
	const SESSION_ID_PREFIX = 'cast-session_'

	const RECEIVER_FRIENDLY_NAME = 'Chromecast Emulator'
	const RECEIVER_LABEL = 'Q2hyb21lY2FzdEVtdWxhdG9y' // any stable base64url string will do
	// How long to wait for the receiver app to report its namespaces before announcing the session anyway.
	const APP_READY_TIMEOUT_MS = 10000

	// Sender media commands that Chrome forwards to the receiver, and how Chrome renames some of them.
	const MEDIA_REQUEST_TYPES = new Set([
		'EDIT_TRACKS_INFO',
		'LOAD',
		'MEDIA_GET_STATUS',
		'MEDIA_SET_VOLUME',
		'PAUSE',
		'PLAY',
		'PRECACHE',
		'QUEUE_INSERT',
		'QUEUE_LOAD',
		'QUEUE_REMOVE',
		'QUEUE_REORDER',
		'QUEUE_UPDATE',
		'QUEUE_NEXT',
		'QUEUE_PREV',
		'SEEK',
		'STOP_MEDIA'
	])
	const MEDIA_REQUEST_RENAMES = {
		STOP_MEDIA: 'STOP',
		MEDIA_SET_VOLUME: 'SET_VOLUME',
		MEDIA_GET_STATUS: 'GET_STATUS'
	}

	const log = (...args) => console.debug(LOG_PREFIX, ...args)

	// The most recent messages in each direction, for debugging: castReceiverEmulator.trace
	const TRACE_LIMIT = 500
	const trace = []
	const traceMessage = (direction, message) => {
		trace.push({ time: Date.now(), direction, message })
		if (trace.length > TRACE_LIMIT) trace.shift()
		log(direction, message)
	}

	const randomId = () =>
		typeof crypto !== 'undefined' && crypto.randomUUID
			? crypto.randomUUID()
			: Date.now().toString(36) + Math.random().toString(36).slice(2)

	// ----------- Fake Cast platform

	window.cast = window.cast || {}
	if (!window.cast.__platform__) {
		window.cast.__platform__ = {
			queryPlatformValue: (key) => {
				switch (key) {
					case 'port-for-web-server':
						return IPC_PORT
					case 'device-capabilities':
						return {
							display_supported: true,
							hi_res_audio_supported: false,
							remote_control_input_supported: false,
							touch_input_supported: false
						}
					case 'is-remote-control-mode-enabled':
						return false
					case 'dpad-controls-overlay-disabled':
						return false
					case 'receiver-flags':
						return {
							enable_check_discontinuity_seq_num_for_playlist_reloads: true,
							enable_dpad_ui: false,
							enable_hide_controls_on_timer_when_paused: false,
							enable_synchronize_media_time_with_prev_manifest: true,
							mirror_crossorigin_exactly: false,
							shaka_version_for_u_release: '4.11.11'
						}
					case 'enabled-for-dev':
						return true
					case 'enable-hls-sample-aes':
						return 1
					default:
						return undefined
				}
			}
		}
	}

	// ----------- Fake IPC WebSocket

	const NativeWebSocket = window.WebSocket

	const isIpcUrl = (url) => {
		try {
			const { protocol, hostname, pathname } = new URL(url, location.href)
			return (
				(protocol === 'ws:' || protocol === 'wss:') &&
				(hostname === 'localhost' || hostname === '127.0.0.1') &&
				pathname.endsWith('/v2/ipc')
			)
		} catch {
			return false
		}
	}

	/** Stands in for the receiver SDK's WebSocket to the Cast platform. */
	class CastIpcSocket extends EventTarget {
		constructor(url) {
			super()
			// Own data properties, because the ones inherited from WebSocket.prototype are getter-only.
			const fields = {
				url: String(url),
				readyState: NativeWebSocket.CONNECTING,
				protocol: '',
				extensions: '',
				binaryType: 'blob',
				bufferedAmount: 0
			}
			for (const [name, value] of Object.entries(fields)) {
				Object.defineProperty(this, name, {
					value,
					writable: true,
					enumerable: true,
					configurable: true
				})
			}
			setTimeout(() => {
				if (this.readyState !== NativeWebSocket.CONNECTING) return
				this.readyState = NativeWebSocket.OPEN
				this.dispatchEvent(new Event('open'))
				device.attachSocket(this)
			})
		}

		send(data) {
			if (this.readyState === NativeWebSocket.CONNECTING) {
				throw new DOMException('WebSocket is still connecting', 'InvalidStateError')
			}
			if (this.readyState !== NativeWebSocket.OPEN) return
			if (typeof data === 'string') {
				device.handleIpcMessage(data)
			} else {
				new Blob([data]).text().then((text) => device.handleIpcMessage(text))
			}
		}

		close(code = 1000, reason = '') {
			if (this.readyState === NativeWebSocket.CLOSED) return
			this.readyState = NativeWebSocket.CLOSED
			device.detachSocket(this)
			this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: true }))
		}

		/** Deliver a message from the platform to the receiver SDK. */
		_deliver(text) {
			if (this.readyState !== NativeWebSocket.OPEN) return
			traceMessage('platform -> receiver', text)
			this.dispatchEvent(new MessageEvent('message', { data: text }))
		}
	}
	for (const name of ['open', 'message', 'close', 'error']) {
		const key = Symbol(`on${name}`)
		Object.defineProperty(CastIpcSocket.prototype, `on${name}`, {
			configurable: true,
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
	// Keep `socket instanceof WebSocket` working.
	Object.setPrototypeOf(CastIpcSocket.prototype, NativeWebSocket.prototype)

	window.WebSocket = new Proxy(NativeWebSocket, {
		construct(target, args, newTarget) {
			if (isIpcUrl(args[0])) return new CastIpcSocket(args[0])
			return Reflect.construct(target, args, newTarget === window.WebSocket ? target : newTarget)
		}
	})

	// ----------- Emulated device: one Cast session, many sender clients

	const device = {
		/** @type {CastIpcSocket | null} */
		socket: null,
		/** Messages for the receiver SDK, held until its socket is open and the platform said "ready". */
		pendingIpc: [],
		platformReady: false,

		sessionId: randomId(),
		transportId: `web-${Math.floor(Math.random() * 1e6)}`,
		appId: null,
		launchingSenderId: null,
		appReady: false,
		namespaces: [MEDIA_NAMESPACE],
		statusText: '',
		displayName: document.title || 'Cast Emulator Receiver',
		volume: { controlType: 'attenuation', level: 1, muted: false, stepInterval: 0.05 },
		lastMediaStatus: null,

		/** @type {Map<string, {clientId: string, senderId: string, connection: PresentationConnection, announced: boolean, reconnect: boolean, userAgent: string}>} */
		clients: new Map(),
		/** Maps the request IDs we put on media commands back to the sender's sequence numbers. */
		pendingRequests: new Map(),
		nextRequestId: 1,

		// ---- Receiver SDK side (IPC)

		attachSocket(socket) {
			this.socket = socket
			this.maybeSendPlatformReady()
		},

		detachSocket(socket) {
			if (this.socket === socket) this.socket = null
		},

		sendIpc(namespace, senderId, data) {
			const text = JSON.stringify({
				namespace,
				senderId,
				data: typeof data === 'string' ? data : JSON.stringify(data)
			})
			if (this.socket && this.platformReady) {
				this.socket._deliver(text)
			} else {
				this.pendingIpc.push(text)
			}
		},

		/** Tell the receiver SDK that the platform launched it, once we know which app it is. */
		maybeSendPlatformReady() {
			if (this.platformReady || !this.socket || !this.appId) return
			this.platformReady = true
			this.socket._deliver(
				JSON.stringify({
					namespace: SYSTEM_NAMESPACE,
					senderId: SYSTEM_SENDER_ID,
					data: JSON.stringify({
						type: 'ready',
						applicationId: this.appId,
						applicationName: this.displayName,
						sessionId: this.sessionId,
						launchingSenderId: this.launchingSenderId,
						deviceCapabilities: { display_supported: true, hi_res_audio_supported: false },
						messagesVersion: '1.0',
						version: 'cast-emulator'
					})
				})
			)
			this.sendIpc(SYSTEM_NAMESPACE, SYSTEM_SENDER_ID, {
				type: 'volumechanged',
				level: this.volume.level,
				muted: this.volume.muted
			})
			this.sendIpc(SYSTEM_NAMESPACE, SYSTEM_SENDER_ID, { type: 'visibilitychanged' })
			this.sendIpc(SYSTEM_NAMESPACE, SYSTEM_SENDER_ID, { type: 'standbychanged' })
			for (const text of this.pendingIpc.splice(0)) this.socket._deliver(text)

			setTimeout(() => {
				if (!this.appReady) {
					console.warn(
						LOG_PREFIX,
						'receiver app did not report its namespaces; announcing the session anyway'
					)
					this.onAppReady()
				}
			}, APP_READY_TIMEOUT_MS)
		},

		/** A message from the receiver SDK to the platform or to a sender. */
		handleIpcMessage(text) {
			traceMessage('receiver -> platform', text)
			let message
			try {
				message = JSON.parse(text)
			} catch {
				console.warn(LOG_PREFIX, 'ignoring malformed IPC message', text)
				return
			}
			const { namespace, senderId: destination } = message
			const rawData = message.data
			let data = rawData
			if (typeof rawData === 'string') {
				try {
					data = JSON.parse(rawData)
				} catch {
					data = rawData
				}
			}

			if (namespace === SYSTEM_NAMESPACE) return this.handleSystemMessage(data)
			if (namespace === MEDIA_NAMESPACE) return this.handleMediaMessage(destination, data)

			// Custom namespace: forward as-is to the sender(s).
			for (const client of this.clientsFor(destination)) {
				this.sendToClient(client, 'app_message', {
					sessionId: this.sessionId,
					namespaceName: namespace,
					message: typeof rawData === 'string' ? rawData : JSON.stringify(rawData)
				})
			}
		},

		handleSystemMessage(data) {
			switch (data?.type) {
				case 'ready': {
					if (Array.isArray(data.activeNamespaces)) {
						const names = data.activeNamespaces.filter(
							(name) => !name.startsWith(RESERVED_NAMESPACE_PREFIX) || name === MEDIA_NAMESPACE
						)
						this.namespaces = [...new Set([MEDIA_NAMESPACE, ...names])]
					}
					if (data.statusText) this.statusText = data.statusText
					this.onAppReady()
					break
				}
				case 'setappstate':
					this.statusText = data.statusText || ''
					this.broadcastSessionUpdate()
					break
				// CAF's CastReceiverContext#stop() just closes the window, which presentation-polyfill.js reports
				// to the senders. These messages are a fallback for receivers that ask the platform to stop.
				case 'stopapplication':
				case 'stop':
					this.stopSession()
					break
				default:
					log('system message from receiver', data)
			}
		},

		handleMediaMessage(destination, data) {
			if (!data || typeof data !== 'object') return
			const pending = this.pendingRequests.get(data.requestId)
			if (pending) this.pendingRequests.delete(data.requestId)

			if (data.type === 'MEDIA_STATUS') {
				// Like Chrome, tag each media status with the session ID; the sender SDK needs it to find the session.
				// Chrome also turns the supportedMediaCommands bit mask into the list of names the sender SDK expects.
				if (Array.isArray(data.status)) {
					for (const status of data.status) {
						status.sessionId = this.sessionId
						if (typeof status.supportedMediaCommands === 'number') {
							status.supportedMediaCommands = mediaCommandsToList(status.supportedMediaCommands)
						}
					}
				}
				this.lastMediaStatus = data.status || null
				// The receiver may have created a new media element.
				this.applyDeviceVolume()
				// Every sender gets media status updates; only the one that asked gets the sequence number.
				for (const client of this.clients.values()) {
					if (!client.announced) continue
					const sequenceNumber =
						pending?.clientId === client.clientId ? pending.sequenceNumber : undefined
					this.sendToClient(client, 'v2_message', data, sequenceNumber)
				}
				return
			}
			for (const client of this.clientsFor(destination)) {
				const sequenceNumber =
					pending?.clientId === client.clientId ? pending.sequenceNumber : undefined
				this.sendToClient(client, 'v2_message', data, sequenceNumber)
			}
		},

		/**
		 * A real device applies its volume to the audio output, outside the page. We emulate that by
		 * setting it on the receiver's media elements, which overrides the receiver's own stream volume.
		 */
		applyDeviceVolume() {
			for (const media of findMediaElements(document)) {
				if (media.volume !== this.volume.level) media.volume = this.volume.level
				if (media.muted !== this.volume.muted) media.muted = this.volume.muted
			}
		},

		onAppReady() {
			if (this.appReady) return
			this.appReady = true
			for (const client of this.clients.values()) this.announceSession(client)
		},

		// ---- Sender SDK side (Presentation connections)

		addConnection(connection) {
			const url = new URL(connection.url)
			const cast = window.castSenderEmulator?.parseCastUrl?.(connection.url) || parseCastUrl(url)
			if (!cast) {
				console.warn(
					LOG_PREFIX,
					'ignoring connection with a non-Cast presentation URL',
					connection.url
				)
				return
			}
			const { clientId } = cast
			const info = connection.polyfillInfo || {}
			const client = {
				clientId,
				senderId: `${this.transportId}.emulator:${clientId}`,
				connection,
				announced: false,
				reconnect: !!info.reconnect,
				userAgent: info.userAgent || ''
			}
			const previous = this.clients.get(clientId)
			if (previous && previous.connection !== connection) previous.connection.close()
			this.clients.set(clientId, client)

			connection.addEventListener('message', (event) =>
				this.handleClientMessage(client, event.data)
			)
			connection.addEventListener('close', () => this.removeClient(client))
			connection.addEventListener('terminate', () => this.removeClient(client))

			if (!this.appId) {
				this.appId = cast.appIds[0]
				// The sender emulator names the presentation after the session, so senders can rejoin it by ID.
				if (connection.id?.startsWith(SESSION_ID_PREFIX)) {
					this.sessionId = connection.id.slice(SESSION_ID_PREFIX.length)
				}
				this.launchingSenderId = client.senderId
				this.maybeSendPlatformReady()
			}
			if (this.appReady) this.announceSession(client)
		},

		removeClient(client) {
			if (this.clients.get(client.clientId) !== client) return
			this.clients.delete(client.clientId)
			if (client.announced) {
				this.sendIpc(SYSTEM_NAMESPACE, SYSTEM_SENDER_ID, {
					type: 'senderdisconnected',
					senderId: client.senderId,
					reason: 'requested_by_sender'
				})
			}
		},

		clientsFor(destination) {
			if (!destination || destination === '*')
				return [...this.clients.values()].filter((c) => c.announced)
			for (const client of this.clients.values()) {
				if (client.senderId === destination || client.clientId === destination) return [client]
			}
			return []
		},

		/** Tell a sender that the session started (or that it joined one), like Chrome does after a launch. */
		announceSession(client) {
			if (client.announced || client.connection.state !== 'connected') return
			client.announced = true
			if (!client.reconnect) {
				this.sendToClient(client, 'receiver_action', {
					receiver: { ...this.receiverInfo(), volume: null },
					action: 'cast'
				})
			}
			this.sendToClient(client, 'new_session', this.sessionInfo())
			this.sendIpc(SYSTEM_NAMESPACE, SYSTEM_SENDER_ID, {
				type: 'senderconnected',
				senderId: client.senderId,
				userAgent: client.userAgent,
				largeMessageSupported: false
			})
		},

		receiverInfo() {
			return {
				label: RECEIVER_LABEL,
				friendlyName: RECEIVER_FRIENDLY_NAME,
				capabilities: ['video_out', 'audio_out'],
				volume: { ...this.volume },
				isActiveInput: null,
				displayStatus: null,
				receiverType: 'cast'
			}
		},

		sessionInfo() {
			const session = {
				sessionId: this.sessionId,
				appId: this.appId,
				transportId: this.transportId,
				receiver: this.receiverInfo(),
				displayName: this.displayName,
				senderApps: [],
				statusText: this.statusText,
				appImages: [],
				namespaces: this.namespaces.map((name) => ({ name }))
			}
			if (this.lastMediaStatus) session.media = this.lastMediaStatus
			return session
		},

		broadcastSessionUpdate() {
			for (const client of this.clients.values()) {
				if (client.announced) this.sendToClient(client, 'update_session', this.sessionInfo())
			}
		},

		/** Send a message in the format Chrome uses between the Media Router and the sender SDK. */
		sendToClient(client, type, message, sequenceNumber) {
			if (client.connection.state !== 'connected') return
			const isEmpty = !message || (typeof message === 'object' && Object.keys(message).length === 0)
			const payload = { type, message: isEmpty ? null : message }
			if (sequenceNumber !== undefined) payload.sequenceNumber = sequenceNumber
			payload.timeoutMillis = 0
			payload.clientId = client.clientId
			traceMessage('emulator -> sender', payload)
			client.connection.send(JSON.stringify(payload))
		},

		sendError(client, sequenceNumber, code, description) {
			this.sendToClient(
				client,
				'error',
				{ code, description: description || null, details: null },
				sequenceNumber
			)
		},

		handleClientMessage(client, raw) {
			traceMessage('sender -> emulator', raw)
			let message
			try {
				message = JSON.parse(raw)
			} catch {
				console.warn(LOG_PREFIX, 'ignoring malformed sender message', raw)
				return
			}
			removeNullFields(message)
			const { type, sequenceNumber } = message
			const body = message.message

			switch (type) {
				case 'client_connect':
				case 'client_disconnect':
					// Obsolete; Chrome ignores these too.
					break

				case 'app_message': {
					const namespace = body?.namespaceName
					if (!this.namespaces.includes(namespace)) {
						this.sendError(
							client,
							sequenceNumber,
							'invalid_parameter',
							`Invalid namespace: ${namespace}`
						)
						break
					}
					this.sendIpc(namespace, client.senderId, body.message)
					this.sendToClient(client, 'app_message', null, sequenceNumber)
					break
				}

				case 'v2_message':
					this.handleV2Message(client, body || {}, sequenceNumber)
					break

				case 'leave_session':
					this.sendToClient(client, 'leave_session', null, sequenceNumber)
					client.connection.close()
					break

				default:
					log('unhandled sender message', message)
			}
		},

		handleV2Message(client, body, sequenceNumber) {
			const { type } = body
			if (MEDIA_REQUEST_TYPES.has(type)) {
				const requestId = this.nextRequestId++
				this.pendingRequests.set(requestId, { clientId: client.clientId, sequenceNumber })
				this.sendIpc(MEDIA_NAMESPACE, client.senderId, {
					...body,
					type: MEDIA_REQUEST_RENAMES[type] || type,
					requestId
				})
				return
			}
			switch (type) {
				case 'SET_VOLUME': {
					const { level, muted } = body.volume || {}
					if (typeof level === 'number') this.volume.level = Math.min(1, Math.max(0, level))
					if (typeof muted === 'boolean') this.volume.muted = muted
					this.applyDeviceVolume()
					this.sendIpc(SYSTEM_NAMESPACE, SYSTEM_SENDER_ID, {
						type: 'volumechanged',
						level: this.volume.level,
						muted: this.volume.muted
					})
					this.sendToClient(client, 'v2_message', null, sequenceNumber)
					this.broadcastSessionUpdate()
					break
				}
				case 'STOP':
					this.sendToClient(client, 'v2_message', null, sequenceNumber)
					this.stopSession()
					break
				default:
					this.sendError(
						client,
						sequenceNumber,
						'invalid_parameter',
						`Unknown v2 message type: ${type}`
					)
			}
		},

		stopSession() {
			for (const client of this.clients.values()) {
				if (client.announced) {
					this.sendToClient(client, 'receiver_action', {
						receiver: { ...this.receiverInfo(), volume: null },
						action: 'stop'
					})
				}
			}
			const anyConnection = [...this.clients.values()][0]?.connection
			if (anyConnection) {
				// Terminating from the receiving side closes this window and tells every sender.
				anyConnection.terminate()
			} else {
				window.close()
			}
		}
	}

	/** Fallback when the sender script (with its URL parser) is not on this page. */
	const parseCastUrl = (url) => {
		if (url.protocol === 'cast:' && url.pathname) {
			return { appIds: [url.pathname], clientId: url.searchParams.get('clientId') || '' }
		}
		const match = /__castAppId__=([^/(]+)/.exec(url.hash)
		if (!match) return null
		const clientId = /__castClientId__=([^/]+)/.exec(url.hash)?.[1] || ''
		return { appIds: [decodeURIComponent(match[1])], clientId: decodeURIComponent(clientId) }
	}

	// The media commands Chrome reports to the sender SDK, by their bit in CAF's supportedMediaCommands.
	const MEDIA_COMMAND_NAMES = [
		[1 << 0, 'pause'],
		[1 << 1, 'seek'],
		[1 << 2, 'stream_volume'],
		[1 << 3, 'stream_mute'],
		[1 << 6, 'queue_next'],
		[1 << 7, 'queue_prev']
	]
	const mediaCommandsToList = (mask) =>
		MEDIA_COMMAND_NAMES.filter(([bit]) => mask & bit).map(([, name]) => name)

	/** All audio and video elements in a document, including inside open shadow roots like <cast-media-player>. */
	const findMediaElements = (root) => {
		const found = [...root.querySelectorAll('audio, video')]
		for (const element of root.querySelectorAll('*')) {
			if (element.shadowRoot) found.push(...findMediaElements(element.shadowRoot))
		}
		return found
	}

	/** Chrome strips null fields from sender messages before handling them. */
	const removeNullFields = (value) => {
		if (Array.isArray(value)) {
			value.forEach(removeNullFields)
		} else if (value && typeof value === 'object') {
			for (const key of Object.keys(value)) {
				if (value[key] === null) delete value[key]
				else removeNullFields(value[key])
			}
		}
	}

	// ----------- Autoplay

	/**
	 * The receiver window opens without a user gesture of its own, so Chrome's autoplay policy blocks
	 * the receiver from playing media with sound. Ask for one click on the receiver window to unlock it.
	 */
	const requestUserActivation = () => {
		if (!navigator.userActivation || navigator.userActivation.hasBeenActive) return
		const overlay = document.createElement('button')
		overlay.type = 'button'
		overlay.textContent = 'Click to allow media playback in this receiver window'
		overlay.style.cssText =
			'position:fixed;inset:auto 0 0 0;z-index:2147483647;padding:12px;border:0;' +
			'background:rgba(0,0,0,0.8);color:white;font:16px sans-serif;cursor:pointer'
		const dismiss = () => {
			overlay.remove()
			window.removeEventListener('pointerdown', dismiss, true)
			window.removeEventListener('keydown', dismiss, true)
		}
		window.addEventListener('pointerdown', dismiss, true)
		window.addEventListener('keydown', dismiss, true)
		document.documentElement.append(overlay)
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', requestUserActivation, { once: true })
	} else {
		requestUserActivation()
	}

	// ----------- Accept sender connections

	const receiver = navigator.presentation?.receiver
	if (receiver && window.presentationPolyfill) {
		receiver.connectionList.then((list) => {
			list.connections.forEach((connection) => device.addConnection(connection))
			list.addEventListener('connectionavailable', (event) =>
				device.addConnection(event.connection)
			)
		})
	} else {
		console.info(LOG_PREFIX, 'not opened as a presentation; waiting without a sender')
	}

	window.castReceiverEmulator = { device, trace }
})()
