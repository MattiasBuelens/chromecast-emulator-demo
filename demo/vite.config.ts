import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	build: {
		// Keep the emulator scripts as files, rather than inlining small ones as data: URLs.
		assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined)
	}
});
