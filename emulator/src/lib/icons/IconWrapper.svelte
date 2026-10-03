<script lang="ts">
	type IconWrapperProps = {
		onClicked?: () => void
		/** The button's accessible name, since it only shows an icon. */
		label?: string
		children: any
	}
	let { children, onClicked, label }: IconWrapperProps = $props()
</script>

<button onclick={() => onClicked?.()} aria-label={label} title={label}>
	{@render children()}
</button>

<style lang="scss">
	button {
		background: transparent;
		border: none;
		outline: none;
		cursor: pointer;
	}
</style>
