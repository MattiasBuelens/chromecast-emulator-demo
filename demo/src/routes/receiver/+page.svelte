<script lang="ts">
	import { loadScripts } from '$lib/loadScript'
	import castReceiverEmulatorUrl from '@mattiasbuelens/chromecast-emulator/cast-receiver-emulator.js?url'
	import presentationPolyfillUrl from '@mattiasbuelens/chromecast-emulator/presentation-polyfill.js?url'
	import { getReceiverCast } from '$lib/receiverCast'
	import type { CastReceiverContext } from 'chromecast-caf-receiver/cast.framework'
	import type { LoadRequestData } from 'chromecast-caf-receiver/cast.framework.messages'
	import { onDestroy, onMount, tick } from 'svelte'

	const CAST_RECEIVER_SDK_URL =
		'https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js'

	let castContext: CastReceiverContext | null = null
	let castAvailable: boolean = $state(false)

	onMount(async () => {
		// The emulator scripts must run before the receiver SDK, so it connects to the emulated platform.
		await loadScripts([
			presentationPolyfillUrl,
			castReceiverEmulatorUrl,
			CAST_RECEIVER_SDK_URL
		])
		castAvailable = true
		// Render <cast-media-player> before starting, so the SDK plays media in it.
		await tick()
		startReceiver()
	})

	// ----------- Start the Chromecast Session once the receiver SDK is loaded
	const startReceiver = () => {
		const { framework } = getReceiverCast()
		const context = framework.CastReceiverContext.getInstance()
		castContext = context
		const options = new framework.CastReceiverOptions()
		options.shakaVersion = '4.9.2'
		options.useShakaForHls = true

		context
			.getPlayerManager()
			.setMessageInterceptor(framework.messages.MessageType.LOAD, updateLoadRequest)

		context.start(options)
	}

	// ----------- Update the Load Requests
	const updateLoadRequest = (loadRequest: LoadRequestData) => {
		loadRequest.autoplay = true
		return loadRequest
	}

	// ----------- Destroy the Chromecast Session whenever we kill this page.
	onDestroy(() => {
		castContext?.stop()
	})
</script>

<div class="chromecast-receiver">
	{#if castAvailable}
		<cast-media-player></cast-media-player>
	{:else}
		<div>Loading...</div>
	{/if}
</div>

<style>
	cast-media-player {
		--splash-image: url('./splash-icon.png');
		--splash-size: contain;
	}
</style>
