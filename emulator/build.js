// Copies the emulator scripts to dist/, along with a minified version of each.
// The scripts are self-contained classic scripts, so they need no bundling.
import { transform } from 'esbuild'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const SCRIPTS = ['presentation-polyfill', 'cast-sender-emulator', 'cast-receiver-emulator']

const src = new URL('./src/', import.meta.url)
const dist = new URL('./dist/', import.meta.url)

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

for (const name of SCRIPTS) {
	const input = new URL(`${name}.js`, src)
	await copyFile(input, new URL(`${name}.js`, dist))
	const { code } = await transform(await readFile(input, 'utf8'), {
		loader: 'js',
		minify: true,
		target: 'es2020'
	})
	await writeFile(new URL(`${name}.min.js`, dist), code)
}
