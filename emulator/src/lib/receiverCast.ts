import type { cast as ReceiverCast } from 'chromecast-caf-receiver'

/**
 * The receiver SDK's `cast` global.
 *
 * Both Cast SDKs define a global `cast` object, and their type definitions clash. The global
 * declaration comes from the sender SDK's types, so receiver code reads it through this instead.
 */
export const getReceiverCast = (): typeof ReceiverCast =>
	(window as unknown as { cast: typeof ReceiverCast }).cast
