/**
 * @module
 *
 * Rate-limit plugin for GramIO
 */
import type { BotLike, Context } from "@gramio/contexts";
import { inMemoryStorage } from "@gramio/storage";
import type { Storage } from "@gramio/storage";
import type { ContextCallback } from "gramio";
import { Plugin } from "gramio";

export type { Storage };

export interface RateLimitOptions {
	/** Maximum number of requests allowed within the window */
	limit: number;
	/** Time window in seconds */
	window: number;
	/**
	 * Optional identifier to keep counters separate per handler.
	 * @example "pay", "help", "subscribe"
	 */
	id?: string;
	/**
	 * Per-handler callback invoked when the limit is exceeded.
	 * Receives the properly-typed handler context — takes precedence over
	 * the global `onLimitExceeded` from plugin options.
	 *
	 * @example
	 * ```ts
	 * bot.command("pay", handler, {
	 *     rateLimit: {
	 *         limit: 3,
	 *         window: 60,
	 *         onLimitExceeded: (ctx) => ctx.reply("Slow down!"),
	 *     },
	 * });
	 * ```
	 */
	onLimitExceeded?: ContextCallback;
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
	 * Global fallback called when the limit is exceeded and no per-handler
	 * `onLimitExceeded` was provided.
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
 * Registers a `rateLimit` macro that can be passed as a handler option.
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
 * bot.command("pay", handler, {
 *     rateLimit: { limit: 3, window: 60 },
 * });
 *
 * bot.command("help", handler, {
 *     rateLimit: {
 *         id: "help",
 *         limit: 20,
 *         window: 60,
 *         // per-handler override with properly-typed ctx:
 *         onLimitExceeded: (ctx) => ctx.reply("Help is rate-limited too!"),
 *     },
 * });
 *
 * await bot.start();
 * ```
 */
export function rateLimitPlugin(opts: RateLimitPluginOptions = {}) {
	const storage = opts.storage ?? inMemoryStorage();
	const getKey = opts.key ?? defaultKey;

	return new Plugin("@gramio/rate-limit").macro(
		"rateLimit",
		(macroOpts: RateLimitOptions) => ({
			preHandler: async (ctx, next) => {
				const entityKey = getKey(ctx);
				if (entityKey == null) return next();

				const storageKey = `rl:${macroOpts.id ?? "default"}:${entityKey}`;

				const allowed = await checkSlidingWindow(
					storage,
					storageKey,
					macroOpts.limit,
					macroOpts.window * 1000,
				);

				if (!allowed) {
					if (macroOpts.onLimitExceeded) {
						await macroOpts.onLimitExceeded(ctx as never);
					} else {
						await opts.onLimitExceeded?.(ctx);
					}
					return;
				}
				return next();
			},
		}),
	);
}
