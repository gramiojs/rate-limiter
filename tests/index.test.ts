import { describe, expect, it } from "bun:test";
import { TelegramTestEnvironment } from "@gramio/test";
import { inMemoryStorage } from "@gramio/storage";
import { Bot } from "gramio";
import { rateLimitPlugin } from "../src/index.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeBot(pluginOpts: Parameters<typeof rateLimitPlugin>[0] = {}) {
	return new Bot("test").extend(rateLimitPlugin(pluginOpts));
}

// ─── sliding-window (core algorithm) ────────────────────────────────────────

describe("sliding window", () => {
	it("allows all requests within the limit", async () => {
		const bot = makeBot();
		let handled = 0;
		bot.command("cmd", () => { handled++; }, { rateLimit: { limit: 3, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("cmd");
		await user.sendCommand("cmd");
		await user.sendCommand("cmd");

		expect(handled).toBe(3);
	});

	it("blocks the request that exceeds the limit", async () => {
		const bot = makeBot();
		let handled = 0;
		bot.command("cmd", () => { handled++; }, { rateLimit: { limit: 3, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("cmd");
		await user.sendCommand("cmd");
		await user.sendCommand("cmd");
		await user.sendCommand("cmd"); // 4th — should be blocked

		expect(handled).toBe(3);
	});

	it("resets the window after the time expires", async () => {
		const storage = inMemoryStorage();
		const bot = makeBot({ storage });
		let handled = 0;
		bot.command("cmd", () => { handled++; }, { rateLimit: { id: "cmd", limit: 2, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser({ id: 100 });

		const original = Date.now;

		// fill up the window
		await user.sendCommand("cmd");
		await user.sendCommand("cmd");
		expect(handled).toBe(2);

		// advance time past the window (61 s)
		Date.now = () => original() + 61_000;

		try {
			await user.sendCommand("cmd");
			expect(handled).toBe(3);
		} finally {
			Date.now = original;
		}
	});
});

// ─── key isolation ───────────────────────────────────────────────────────────

describe("key isolation", () => {
	it("keeps independent counters for different users", async () => {
		const bot = makeBot();
		let handled = 0;
		bot.command("cmd", () => { handled++; }, { rateLimit: { limit: 1, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const userA = env.createUser({ id: 1 });
		const userB = env.createUser({ id: 2 });

		await userA.sendCommand("cmd"); // A: 1 → allowed
		await userB.sendCommand("cmd"); // B: 1 → allowed
		await userA.sendCommand("cmd"); // A: 2 → blocked (limit=1)

		expect(handled).toBe(2);
	});

	it("separates counters by `id` across handlers", async () => {
		const storage = inMemoryStorage();
		const bot = makeBot({ storage });
		let payHandled = 0;
		let helpHandled = 0;

		bot.command("pay", () => { payHandled++; }, {
			rateLimit: { id: "pay", limit: 1, window: 60 },
		});
		bot.command("help", () => { helpHandled++; }, {
			rateLimit: { id: "help", limit: 2, window: 60 },
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser({ id: 42 });

		await user.sendCommand("pay");  // pay:1 → allowed
		await user.sendCommand("pay");  // pay:2 → blocked
		await user.sendCommand("help"); // help:1 → allowed
		await user.sendCommand("help"); // help:2 → allowed
		await user.sendCommand("help"); // help:3 → blocked

		expect(payHandled).toBe(1);
		expect(helpHandled).toBe(2);
	});

	it("shares the counter when no `id` is provided", async () => {
		// Both commands omit `id` → both write to the "default" bucket per user.
		// Each send from the same user increments the shared counter.
		const bot = makeBot();
		let total = 0;

		bot.command("a", () => { total++; }, { rateLimit: { limit: 2, window: 60 } });
		bot.command("b", () => { total++; }, { rateLimit: { limit: 2, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser({ id: 7 });

		await user.sendCommand("a"); // default:1 → allowed
		await user.sendCommand("b"); // default:2 → allowed
		await user.sendCommand("a"); // default:3 → blocked (limit=2)

		expect(total).toBe(2);
	});

	it("works with callback_query (uses from.id as key)", async () => {
		const bot = makeBot();
		let handled = 0;
		// bot.callbackQuery() supports macro options; bot.on() does not
		bot.callbackQuery("btn", () => { handled++; }, { rateLimit: { limit: 1, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser({ id: 55 });
		const msg = await user.sendMessage("test");

		await user.click("btn", msg); // 1 → allowed
		await user.click("btn", msg); // 2 → blocked

		expect(handled).toBe(1);
	});
});

// ─── onLimitExceeded callbacks ───────────────────────────────────────────────

describe("onLimitExceeded", () => {
	it("calls the global callback when limit is exceeded", async () => {
		const exceeded: number[] = [];
		const bot = makeBot({
			onLimitExceeded: (ctx) => {
				if ("from" in ctx && typeof ctx.from === "object" && ctx.from !== null && "id" in ctx.from) {
					exceeded.push(ctx.from.id as number);
				}
			},
		});
		bot.command("cmd", () => {}, { rateLimit: { limit: 1, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser({ id: 9 });

		await user.sendCommand("cmd"); // allowed
		await user.sendCommand("cmd"); // blocked → callback fires

		expect(exceeded).toEqual([9]);
	});

	it("calls the per-handler callback and does NOT call the global one", async () => {
		let globalCalled = false;
		let perHandlerCalled = false;

		const bot = makeBot({
			onLimitExceeded: () => { globalCalled = true; },
		});
		bot.command("cmd", () => {}, {
			rateLimit: {
				limit: 1,
				window: 60,
				onLimitExceeded: () => { perHandlerCalled = true; },
			},
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("cmd"); // allowed
		await user.sendCommand("cmd"); // blocked → per-handler fires

		expect(perHandlerCalled).toBe(true);
		expect(globalCalled).toBe(false);
	});

	it("does not call any callback when request is allowed", async () => {
		let called = false;
		const bot = makeBot({ onLimitExceeded: () => { called = true; } });
		bot.command("cmd", () => {}, { rateLimit: { limit: 5, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("cmd");
		await user.sendCommand("cmd");

		expect(called).toBe(false);
	});
});

// ─── handler body isolation ───────────────────────────────────────────────────

describe("handler body", () => {
	it("does not run the handler body when blocked", async () => {
		const executed: string[] = [];
		const bot = makeBot();
		bot.command("cmd", () => { executed.push("ran"); }, { rateLimit: { limit: 1, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("cmd"); // allowed
		await user.sendCommand("cmd"); // blocked

		expect(executed).toEqual(["ran"]);
	});
});

// ─── custom key extractor ─────────────────────────────────────────────────────

describe("custom key extractor", () => {
	it("uses the provided key function", async () => {
		// Key always returns the same constant → all users share one bucket
		const bot = makeBot({
			key: () => "shared",
		});
		let handled = 0;
		bot.command("cmd", () => { handled++; }, { rateLimit: { limit: 2, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const userA = env.createUser({ id: 1 });
		const userB = env.createUser({ id: 2 });

		await userA.sendCommand("cmd"); // shared:1 → allowed
		await userB.sendCommand("cmd"); // shared:2 → allowed (same bucket!)
		await userA.sendCommand("cmd"); // shared:3 → blocked

		expect(handled).toBe(2);
	});

	it("allows the request when key returns undefined", async () => {
		const bot = makeBot({ key: () => undefined });
		let handled = 0;
		bot.command("cmd", () => { handled++; }, { rateLimit: { limit: 1, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		// With no key, rate limiting is skipped entirely
		await user.sendCommand("cmd");
		await user.sendCommand("cmd");
		await user.sendCommand("cmd");

		expect(handled).toBe(3);
	});
});

// ─── custom storage ───────────────────────────────────────────────────────────

describe("custom storage", () => {
	it("writes timestamps to the provided storage", async () => {
		const map = new Map<string, number[]>();
		const storage = {
			get: async (key: string) => map.get(key),
			set: async (key: string, value: number[]) => { map.set(key, value); },
			has: async (key: string) => map.has(key),
			delete: async (key: string) => map.delete(key),
		};

		const bot = makeBot({ storage });
		bot.command("cmd", () => {}, { rateLimit: { id: "cmd", limit: 5, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser({ id: 77 });

		await user.sendCommand("cmd");
		await user.sendCommand("cmd");

		const key = "rl:cmd:77";
		expect(map.has(key)).toBe(true);
		expect(map.get(key)).toHaveLength(2);
	});

	it("blocks based on data already in storage", async () => {
		const map = new Map<string, number[]>();
		const storage = {
			get: async (key: string) => map.get(key),
			set: async (key: string, value: number[]) => { map.set(key, value); },
			has: async (key: string) => map.has(key),
			delete: async (key: string) => map.delete(key),
		};

		// Pre-fill storage: user 99 already used the limit
		const now = Date.now();
		map.set("rl:cmd:99", [now - 5000, now - 3000, now - 1000]); // 3 within last 60s

		const bot = makeBot({ storage });
		let handled = 0;
		bot.command("cmd", () => { handled++; }, { rateLimit: { id: "cmd", limit: 3, window: 60 } });

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser({ id: 99 });

		await user.sendCommand("cmd"); // already at limit → blocked

		expect(handled).toBe(0);
	});
});
