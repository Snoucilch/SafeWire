# SafeWire

Validated, rate-limited RemoteEvents for Roblox, written in strict Luau.

Exploiters can fire any RemoteEvent with any arguments: `NaN`, `math.huge`, negative numbers, wrong types, giant tables. SafeWire checks every argument and every player's request rate **on the server** before your handler runs. Bad requests are dropped.

## Why

- **One definition, both sides.** Define each event once in a shared module. Server and client use the same checks.
- **Checks that catch real exploits.** Numbers reject `NaN` and infinity. Tables reject unknown keys. Arrays reject gaps. Strings have a length limit.
- **Rate limiting built in.** A token bucket per player, per event. Buckets are cleared when the player leaves.
- **Small and readable.** Three files, no dependencies.

## Install

**Wally**

```toml
[dependencies]
SafeWire = "your-github-name/safewire@0.1.0"
```

**Manual:** copy the `src` folder into `ReplicatedStorage` and rename it `SafeWire`.

## Quick start

**1. Define events (ReplicatedStorage/Remotes)**

```lua
local SafeWire = require(ReplicatedStorage.Packages.SafeWire)
local t = SafeWire.t

return {
	BuyItem = SafeWire.event("BuyItem", { t.string(40), t.integer(1, 99) }, { rate = 2, burst = 4 }),
	Notify = SafeWire.event("Notify", {}),
}
```

**2. Server**

```lua
Remotes.BuyItem:onServer(function(player: Player, itemId: string, quantity: number)
	-- itemId is a string of at most 40 bytes, quantity is a whole number from 1 to 99.
	-- Still check game rules here: does the item exist, can the player afford it?
end)
```

**3. Client**

```lua
Remotes.BuyItem:fire("potion", 2)
Remotes.Notify:onClient(function(message: string) print(message) end)
```

A full example is in [`examples/`](examples).

## Checks (`SafeWire.t`)

| Check | Accepts |
| --- | --- |
| `t.string(maxLength?)` | Valid UTF-8 string, default max 200 bytes |
| `t.number(min?, max?)` | Finite number (no NaN, no infinity) in range |
| `t.integer(min?, max?)` | Whole number in range |
| `t.boolean()` | `true` or `false` |
| `t.literal(...)` | One of the listed values |
| `t.optional(check)` | `nil` or a value passing `check` |
| `t.object({ key = check })` | Table with exactly these keys |
| `t.array(check, maxLength?)` | List without gaps, default max 100 items |
| `t.instanceOf(className)` | Instance that `IsA(className)` |
| `t.vector3(maxMagnitude?)` | Vector3 with finite parts |

A check is just a function `(value: unknown) -> (boolean, string?)`, so you can write your own.

## Event API

| Method | Side | What it does |
| --- | --- | --- |
| `SafeWire.event(name, checks, options?)` | shared | Defines an event |
| `event:onServer(handler)` | server | Runs `handler(player, ...)` for valid requests only |
| `event:fireClient(player, ...)` | server | Sends to one player |
| `event:fireAllClients(...)` | server | Sends to everyone |
| `event:fire(...)` | client | Sends to the server (checked locally too, to catch bugs early) |
| `event:onClient(handler)` | client | Listens for server messages |

**Options:** `rate` (tokens per second, default 10), `burst` (default 20), `onReject(player, reason)` for logging. In Studio, dropped requests are printed with `warn` when no `onReject` is set.

## What SafeWire does not do

SafeWire checks **shape and rate**. It cannot know your game rules. Your handler must still check things like prices, ownership, distance and cooldowns. Never trust the client to tell you how much damage it did or how much something costs.

## Development

```sh
luau tests/run.luau          # unit tests (Luau CLI)
stylua --check src tests examples
selene src
```

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
