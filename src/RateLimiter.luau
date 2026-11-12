--!strict
--[[
	RateLimiter
	A token bucket per key (usually per Player).

	- `ratePerSecond`: how many tokens come back each second.
	- `burst`: the most tokens a key can hold, so short bursts are allowed.

	The clock can be injected, which keeps this module testable outside Roblox.
]]

type Bucket = {
	tokens: number,
	last: number,
}

local RateLimiter = {}
RateLimiter.__index = RateLimiter

type RateLimiterData = {
	ratePerSecond: number,
	burst: number,
	clock: () -> number,
	buckets: { [unknown]: Bucket },
}

export type RateLimiter = typeof(setmetatable({} :: RateLimiterData, RateLimiter))

function RateLimiter.new(ratePerSecond: number, burst: number, clock: (() -> number)?): RateLimiter
	assert(ratePerSecond > 0, "ratePerSecond must be greater than 0")
	assert(burst >= 1, "burst must be at least 1")
	local data: RateLimiterData = {
		ratePerSecond = ratePerSecond,
		burst = burst,
		clock = clock or os.clock,
		buckets = {},
	}
	return setmetatable(data, RateLimiter)
end

--- Returns true and spends one token if `key` still has budget.
function RateLimiter.allow(self: RateLimiter, key: unknown): boolean
	local now = self.clock()
	local bucket = self.buckets[key]
	if bucket == nil then
		bucket = { tokens = self.burst, last = now }
		self.buckets[key] = bucket
	end
	local elapsed = math.max(0, now - bucket.last)
	bucket.tokens = math.min(self.burst, bucket.tokens + elapsed * self.ratePerSecond)
	bucket.last = now
	if bucket.tokens < 1 then
		return false
	end
	bucket.tokens -= 1
	return true
end

--- Forgets a key. Call this when a player leaves so memory does not grow.
function RateLimiter.remove(self: RateLimiter, key: unknown)
	self.buckets[key] = nil
end

return RateLimiter
