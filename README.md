# @gramio/rate-limit

[![npm](https://img.shields.io/npm/v/@gramio/rate-limit?logo=npm&style=flat&labelColor=000&color=3b82f6)](https://www.npmjs.org/package/@gramio/rate-limit)
[![npm downloads](https://img.shields.io/npm/dw/@gramio/rate-limit?logo=npm&style=flat&labelColor=000&color=3b82f6)](https://www.npmjs.org/package/@gramio/rate-limit)
[![JSR](https://jsr.io/badges/@gramio/rate-limit)](https://jsr.io/@gramio/rate-limit)
[![JSR Score](https://jsr.io/badges/@gramio/rate-limit/score)](https://jsr.io/@gramio/rate-limit)

Rate-limit plugin for [GramIO](https://gramio.dev). Protects your bot handlers from spam using a **sliding-window** algorithm with pluggable storage backends.

```ts
import { Bot } from "gramio";
import { rateLimit } from "@gramio/rate-limit";

const bot = new Bot(process.env.BOT_TOKEN!)
    .extend(
        rateLimit({
            // Optional: bring your own storage (Redis, SQLite, Cloudflare KV…)
            // storage: redisStorage(redis),
            onLimitExceeded: async (ctx) => {
                if (ctx.is("message")) await ctx.reply("Too many requests, please wait.");
            },
        }),
    );

// Per-handler options — the macro runs before the handler body:
bot.command("pay", (ctx) => { /* process payment */ }, {
    rateLimit: { limit: 3, window: 60 },
});

bot.command("help", (ctx) => ctx.reply("Help!"), {
    rateLimit: {
        id: "help",
        limit: 20,
        window: 60,
        // Per-handler override (ctx is typed as the handler's context):
        onLimitExceeded: (ctx) => ctx.reply("Too many /help requests!"),
    },
});

await bot.start();
```

## Installation

```sh
npm install @gramio/rate-limit @gramio/storage
# or
bun add @gramio/rate-limit @gramio/storage
```

## How it works

Each call to `ctx.rateLimit({ id, limit, window })` records a timestamp in the storage under the key `rl:{id}:{userId}`. Timestamps older than `window` seconds are discarded. If the remaining count is `>= limit`, the request is blocked and `onLimitExceeded` is called.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `storage` | `Storage` | `inMemoryStorage()` | Any `@gramio/storage`-compatible adapter |
| `key` | `(ctx) => string \| number \| undefined` | sender/chat id | Determines the rate-limit bucket |
| `onLimitExceeded` | `(ctx) => unknown` | `undefined` | Called when a request is blocked |

## Storage adapters

| Package | Backend |
|---|---|
| [`@gramio/storage`](https://www.npmjs.com/package/@gramio/storage) | In-memory (default) |
| [`@gramio/storage-redis`](https://www.npmjs.com/package/@gramio/storage-redis) | Redis (ioredis) |
| [`@gramio/storage-sqlite`](https://www.npmjs.com/package/@gramio/storage-sqlite) | SQLite |
| [`@gramio/storage-cloudflare`](https://www.npmjs.com/package/@gramio/storage-cloudflare) | Cloudflare KV |

For better documentation, see [GramIO - Rate Limit](https://gramio.dev/plugins/rate-limit).
