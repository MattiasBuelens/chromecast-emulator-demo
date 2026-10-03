<script lang="ts">
	import LoadRequestInput from '$lib/components/LoadRequestInput.svelte'
	import ProgressBar from '$lib/components/ProgressBar.svelte'
	import { DEFAULT_MEDIA, DEFAULT_QUEUED_MEDIA, TemplateLoadRequestEnum } from '$lib/constants'
	import IconWrapper from '$lib/icons/IconWrapper.svelte'
	import MuteIcon from '$lib/icons/MuteIcon.svelte'
	import NextIcon from '$lib/icons/NextIcon.svelte'
	import PauseIcon from '$lib/icons/PauseIcon.svelte'
	import PlayIcon from '$lib/icons/PlayIcon.svelte'
	import PrevIcon from '$lib/icons/PrevIcon.svelte'
	import ReelIcon from '$lib/icons/ReelIcon.svelte'
	import SeekBack10Icon from '$lib/icons/SeekBack10Icon.svelte'
	import SeekForward10Icon from '$lib/icons/SeekForward10Icon.svelte'
	import SoundIcon from '$lib/icons/SoundIcon.svelte'
	import StopIcon from '$lib/icons/StopIcon.svelte'
	import { loadScripts } from '$lib/loadScript'
	import { onDestroy, onMount } from 'svelte'

	// The receiver page that the emulator opens for every receiver application ID.
	const RECEIVER_URL = '/receiver'
	const CAST_SENDER_SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'
	const SKIP_SECONDS = 10

	const DEFAULT_LOAD_REQUEST = JSON.stringify(DEFAULT_MEDIA, null, 2)

	let templateLoadRequest = $state(TemplateLoadRequestEnum.BASIC)
	let loadRequest: string = $state(DEFAULT_LOAD_REQUEST)
	let statusMessage: string = $state('')

	// A snapshot of the RemotePlayer's state. The SDK mutates the RemotePlayer itself, which Svelte can't track.
	let castReady: boolean = $state(false)
	let isConnected: boolean = $state(false)
	let deviceName: string = $state('')
	let isPaused: boolean = $state(true)
	let currentTime: number = $state(0)
	let duration: number = $state(0)
	let volume: number = $state(100)
	let muted: boolean = $state(false)
	let mediaInfo: chrome.cast.media.MediaInfo | undefined = $state()

	let metadata = $derived(mediaInfo?.metadata as Partial<chrome.cast.media.GenericMediaMetadata> | undefined)
	let title = $derived(metadata?.title || '')
	let subtitle = $derived(metadata?.subtitle || '')
	let images = $derived(metadata?.images || [])

	let player: cast.framework.RemotePlayer | null = null
	let controller: cast.framework.RemotePlayerController | null = null

	const syncPlayerState = () => {
		if (!player) return
		isConnected = player.isConnected
		isPaused = player.isPaused
		currentTime = player.currentTime
		duration = player.duration
		volume = Math.round(player.volumeLevel * 100)
		muted = player.isMuted
		mediaInfo = player.mediaInfo
		deviceName = getSession()?.getCastDevice().friendlyName || ''
	}

	const initializeCast = () => {
		const context = cast.framework.CastContext.getInstance()
		context.setOptions({
			receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
			autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
		})
		context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
			console.log('[sender] session state', event.sessionState)
			syncPlayerState()
		})

		player = new cast.framework.RemotePlayer()
		controller = new cast.framework.RemotePlayerController(player)
		controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, syncPlayerState)
		castReady = true
		syncPlayerState()
	}

	onMount(async () => {
		if (window.cast?.framework) {
			// The SDK is still loaded from a previous visit to this page.
			initializeCast()
			return
		}
		window.__onGCastApiAvailable = (isAvailable) => {
			if (isAvailable) initializeCast()
			else statusMessage = 'The Cast SDK is not available in this browser.'
		}
		// The emulator scripts must run before the Cast SDK, so it picks up the Presentation API polyfill.
		await loadScripts([
			'/presentation-polyfill.js',
			['/cast-sender-emulator.js', { receiverUrl: RECEIVER_URL }],
			CAST_SENDER_SDK_URL
		])
	})

	onDestroy(() => {
		controller?.removeEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, syncPlayerState)
	})

	const getSession = () => (castReady ? cast.framework.CastContext.getInstance().getCurrentSession() : null)

	/** Build a LoadRequest from a JSON LOAD message, like the ones in the Cast media messages docs. */
	const createLoadRequest = (json: string) => {
		const { type: _type, requestId: _requestId, media, ...options } = JSON.parse(json)
		if (!media) throw new Error('The load request needs a "media" field')
		const info = Object.assign(
			new chrome.cast.media.MediaInfo(media.contentId ?? media.contentUrl, media.contentType),
			media
		)
		const request = new chrome.cast.media.LoadRequest(info)
		request.autoplay = true
		return Object.assign(request, options)
	}

	const handleMediaLoad = async () => {
		const session = getSession()
		if (!session) {
			statusMessage = 'Connect to a receiver with the cast button first.'
			return
		}
		try {
			const request = createLoadRequest(loadRequest)
			console.log('[sender] load request', request)
			statusMessage = 'Loading...'
			const errorCode = await session.loadMedia(request)
			statusMessage = errorCode ? `Load failed: ${errorCode}` : ''
		} catch (e) {
			console.error(e)
			statusMessage = `Load failed: ${(e as Error)?.message ?? e}`
		}
	}

	const handlePlayPause = (play: boolean) => {
		if (player && controller && player.isPaused === play) controller.playOrPause()
	}

	const handleStop = () => controller?.stop()

	const handleSeek = (time: number) => {
		if (!player || !controller || !player.canSeek) return
		player.currentTime = Math.min(Math.max(0, time), player.duration || Infinity)
		controller.seek()
	}

	const handleQueueJump = (offset: 1 | -1) => {
		const media = getSession()?.getMediaSession()
		if (!media) return
		const onError = (error: chrome.cast.Error) => (statusMessage = `Queue jump failed: ${error.code}`)
		if (offset > 0) media.queueNext(() => {}, onError)
		else media.queuePrev(() => {}, onError)
	}

	const handleMute = () => controller?.muteOrUnmute()

	const handleVolume = () => {
		if (!player || !controller) return
		player.volumeLevel = volume / 100
		controller.setVolumeLevel()
	}

	// ----------- Handle Load Request Template Change
	const handleLoadRequestTemplateChange = (ev: any) => {
		const type = parseInt(ev.target.value || '0')
		switch (type) {
			case TemplateLoadRequestEnum.BASIC:
				loadRequest = JSON.stringify(DEFAULT_MEDIA, null, 2)
				break
			case TemplateLoadRequestEnum.BASIC_QUEUE:
				loadRequest = JSON.stringify(DEFAULT_QUEUED_MEDIA, null, 2)
				break
		}
	}
</script>

<header>
	<div>
		<div style:color={isConnected ? 'var(--col-obj-success)' : 'white'}>
			{isConnected ? `Casting to ${deviceName || 'receiver'}` : 'Cast Locally'}
		</div>
		<google-cast-launcher></google-cast-launcher>
	</div>
	<div>
		<IconWrapper onClicked={handleMediaLoad}><ReelIcon /></IconWrapper>
		<div>Send Load Request</div>
	</div>
</header>

{#if statusMessage}
	<p class="status">{statusMessage}</p>
{/if}

<section class="mini-controller">
	<h2>{@html title || '&nbsp;'}</h2>
	<h3>{@html subtitle || '&nbsp;'}</h3>
	<img src={images?.[0]?.url || 'idle-icon.png'} alt="thumb" />

	<ProgressBar {currentTime} {duration} handleTimeUpdate={handleSeek} />

	<div class="controls">
		<div class="playback">
			<IconWrapper onClicked={() => handlePlayPause(true)}><PlayIcon /></IconWrapper>
			<IconWrapper onClicked={() => handlePlayPause(false)}><PauseIcon /></IconWrapper>
			<IconWrapper onClicked={handleStop}><StopIcon /></IconWrapper>
			<IconWrapper onClicked={() => handleQueueJump(-1)}><PrevIcon /></IconWrapper>
			<IconWrapper onClicked={() => handleQueueJump(1)}><NextIcon /></IconWrapper>
		</div>

		<div class="seek">
			<IconWrapper onClicked={() => handleSeek(currentTime - SKIP_SECONDS)}
				><SeekBack10Icon /></IconWrapper
			>
			<IconWrapper onClicked={() => handleSeek(currentTime + SKIP_SECONDS)}
				><SeekForward10Icon /></IconWrapper
			>
		</div>

		<div class="sound">
			<IconWrapper onClicked={handleMute}>
				{#if muted}
					<MuteIcon />
				{:else}
					<SoundIcon />
				{/if}
			</IconWrapper>
			<input
				type="range"
				bind:value={volume}
				min={0}
				max={100}
				disabled={muted}
				onchange={handleVolume}
			/>
		</div>
	</div>
</section>

<section class="default-requests">
	<h3>Pick from Template:</h3>
	<div>
		<label class:active={templateLoadRequest === TemplateLoadRequestEnum.BASIC}>
			<input
				type="radio"
				value={TemplateLoadRequestEnum.BASIC}
				bind:group={templateLoadRequest}
				onchange={handleLoadRequestTemplateChange}
			/>
			<div>Basic Load Request</div>
		</label>
		<label class:active={templateLoadRequest === TemplateLoadRequestEnum.BASIC_QUEUE}>
			<input
				type="radio"
				value={TemplateLoadRequestEnum.BASIC_QUEUE}
				bind:group={templateLoadRequest}
				onchange={handleLoadRequestTemplateChange}
			/>
			<div>Basic Queue Load Request</div>
		</label>
	</div>
</section>

<LoadRequestInput bind:value={loadRequest} />

<style lang="scss">
	header {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 0.45rem;
		padding: 0 0 1.45rem;
		margin-top: 1.45rem;
		color: white;

		& > div {
			display: flex;
			align-items: center;
			gap: 0.45rem;
		}
	}

	google-cast-launcher {
		display: block;
		width: 40px;
		height: 40px;
		cursor: pointer;
		--disconnected-color: white;
		--connected-color: var(--col-obj-success);
	}

	.status {
		text-align: center;
		color: white;
	}

	.mini-controller {
		display: flex;
		flex-flow: column;
		gap: 0.45rem;
		background: var(--col-obj-primary);
		color: white;
		padding: 0.85rem 1.15rem;
		box-sizing: border-box;
		border: solid 1px var(--col-obj-border);
		border-radius: 0.45rem;

		img {
			max-height: 300px;
			object-fit: contain;
		}

		.controls {
			display: flex;
			flex-flow: row wrap;
			align-items: center;

			.playback {
				display: flex;
				flex-flow: row wrap;
			}

			.seek {
				flex: 1;
				display: flex;
				justify-content: center;
			}

			.sound {
				flex: 1;
				display: flex;
				justify-content: flex-end;
				align-items: center;
			}
		}
	}

	.default-requests {
		display: flex;
		flex-flow: column;
		gap: 0.45rem;
		padding: 1.45rem 0 0.45rem 0;
		color: white;

		& > div {
			display: flex;
			flex-flow: row wrap;
			align-items: center;
			gap: 0.45rem;

			label {
				display: flex;
				flex-flow: row wrap;
				gap: 0.45rem;
				background: var(--col-obj-primary);
				padding: 0.45rem 0.65rem;
				box-sizing: border-box;
				border: solid 1px var(--col-obj-border);
				border-radius: 0.35rem;

				input {
					display: none;
				}

				&.active {
					background: var(--col-obj-accent);
				}
			}
		}
	}
</style>
