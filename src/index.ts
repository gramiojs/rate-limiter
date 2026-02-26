/**
 * @module
 *
 * Rate-limit plugin for GramIO
 */
import type { BotLike, Context } from "@gramio/contexts";
import { inMemoryStorage } from "@gramio/storage";
import type { Storage } from "@gramio/storage";
import { Plugin } from "gramio";

export type { Storage };

export interface RateLimitOptions {
	/** Maximum number of requests allowed within the window */
	limit: number;
	/** Time window in seconds */
	window: number;
	/**
	 * Optional identifier to keep counters separate per handler.
	 * Useful when multiple handlers have different limits for the same user.
	 * @example "pay", "help", "subscribe"
	 */
	id?: string;
}

export interface RateLimitPluginOptions {
	/**
	 * Storage backend. Defaults to in-memory storage.
	 * Use `@gramio/storage-redis`, `@gramio/storage-sqlite`, etc. for production.
	 */
	storage?: Storage;
	/**
	 * Key extractor — determines which entity is rate-limited.
	 * Defaults to the sender's user ID, falling back to the chat ID.
	 */
	key?: (ctx: Context<BotLike>) => string | number | undefined;
	/**
	 * Called when the rate limit is exceeded.
	 * Use `ctx.is("message")` to narrow the context before calling `ctx.reply()`.
	 *
	 * @example
	 * ```ts
	 * onLimitExceeded: async (ctx) => {
	 *     if (ctx.is("message")) await ctx.reply("Too many requests, please wait.");
	 * }
	 * ```
	 */
	onLimitExceeded?: (ctx: Context<BotLike>) => unknown | Promise<unknown>;
}

function defaultKey(ctx: Context<BotLike>): number | undefined {
	const u = ctx.update;
	if (!u) return undefined;

	return (
		u.message?.from?.id ??
		u.edited_message?.from?.id ??
		u.callback_query?.from.id ??
		u.inline_query?.from.id ??
		u.chosen_inline_result?.from.id ??
		u.shipping_query?.from.id ??
		u.pre_checkout_query?.from.id ??
		u.chat_join_request?.from.id ??
		u.chat_member?.from.id ??
		u.my_chat_member?.from.id ??
		u.message_reaction?.user?.id ??
		// channel posts have no `from`, fall back to chat
		u.channel_post?.chat.id ??
		u.edited_channel_post?.chat.id
	);
}

async function checkSlidingWindow(
	storage: Storage,
	key: string,
	limit: number,
	windowMs: number,
): Promise<boolean> {
	const now = Date.now();
	const raw = await storage.get(key);
	const timestamps: number[] = Array.isArray(raw) ? raw : [];

	// Drop timestamps outside the current window
	const valid = timestamps.filter((t) => now - t < windowMs);

	if (valid.length >= limit) return false;

	valid.push(now);
	await storage.set(key, valid);
	return true;
}

/**
 * Rate-limit plugin for GramIO.
 *
 * Injects a `rateLimit(options)` helper into every handler context.
 * Uses a sliding-window algorithm backed by any `@gramio/storage`-compatible adapter.
 *
 * @example
 * ```ts
 * import { Bot } from "gramio";
 * import { rateLimitPlugin } from "@gramio/rate-limit";
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *     .extend(rateLimitPlugin({
 *         onLimitExceeded: async (ctx) => {
 *             if (ctx.is("message")) await ctx.reply("Too many requests, please wait.");
 *         },
 *     }));
 *
 * bot.command("pay", async (ctx) => {
 *     if (!await ctx.rateLimit({ id: "pay", limit: 3, window: 60 })) return;
 *     // process payment...
 * });
 *
 * bot.command("help", async (ctx) => {
 *     if (!await ctx.rateLimit({ id: "help", limit: 20, window: 60 })) return;
 *     await ctx.reply("Help text here");
 * });
 *
 * await bot.start();
 * ```
 */
export function rateLimitPlugin(opts: RateLimitPluginOptions = {}) {
	const storage = opts.storage ?? inMemoryStorage();
	const getKey = opts.key ?? defaultKey;

	return new Plugin("@gramio/rate-limit").derive(async (ctx) => ({
		/**
		 * Check whether the current user/chat is within the rate limit.
		 * Returns `true` if the request is allowed, `false` if it is blocked.
		 * When blocked, `onLimitExceeded` is called automatically.
		 */
		rateLimit: async (rateLimitOpts: RateLimitOptions): Promise<boolean> => {
			const entityKey = getKey(ctx);
			if (entityKey == null) return true;

			const keyId = rateLimitOpts.id ?? "default";
			const storageKey = `rl:${keyId}:${entityKey}`;

			const allowed = await checkSlidingWindow(
				storage,
				storageKey,
				rateLimitOpts.limit,
				rateLimitOpts.window * 1000,
			);

			if (!allowed) {
				await opts.onLimitExceeded?.(ctx);
				return false;
			}
			return true;
		},
	}));
}
