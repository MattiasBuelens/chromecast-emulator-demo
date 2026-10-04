/**
 * Load a classic script and wait for it to run.
 *
 * Scripts added through `<svelte:head>` only run in order on a full page load. When SvelteKit
 * navigates on the client, they are inserted dynamically and run in any order. The emulator
 * scripts must run before the Cast SDKs, so we load them one by one instead.
 */
export const loadScript = (src: string, dataset: Record<string, string> = {}): Promise<void> => {
	const url = new URL(src, document.baseURI).href
	const existing = [...document.scripts].find((script) => script.src === url)
	if (existing) return Promise.resolve()

	return new Promise((resolve, reject) => {
		const script = document.createElement('script')
		Object.assign(script.dataset, dataset)
		script.async = false
		script.src = url
		script.onload = () => resolve()
		script.onerror = () => reject(new Error(`Failed to load ${src}`))
		document.head.append(script)
	})
}

export const loadScripts = async (scripts: Array<string | [string, Record<string, string>]>) => {
	for (const entry of scripts) {
		const [src, dataset] = typeof entry === 'string' ? [entry, {}] : entry
		await loadScript(src, dataset)
	}
}
