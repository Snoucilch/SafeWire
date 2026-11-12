--!strict
-- Run with the Luau CLI from the repo root:  luau tests/run.luau
-- These tests cover the pure modules (no Roblox services needed).

local Validators = require("../src/Validators")
local RateLimiter = require("../src/RateLimiter")

local passed = 0
local failed = 0

local function test(name: string, fn: () -> ())
	local ok, err = pcall(fn)
	if ok then
		passed += 1
	else
		failed += 1
		print(`FAIL  {name}\n      {err}`)
	end
end

local function accepts(check: Validators.Check, value: unknown)
	local ok, reason = check(value)
	assert(ok, `expected value to be accepted, got: {reason}`)
end

local function rejects(check: Validators.Check, value: unknown)
	local ok = check(value)
	assert(not ok, "expected value to be rejected")
end

local NAN = 0 / 0

-- string
test("string accepts normal text", function()
	accepts(Validators.string(), "sword")
end)
test("string rejects non-strings", function()
	rejects(Validators.string(), 5)
	rejects(Validators.string(), nil)
	rejects(Validators.string(), {})
end)
test("string rejects text over the limit", function()
	rejects(Validators.string(3), "abcd")
	accepts(Validators.string(3), "abc")
end)
test("string rejects invalid UTF-8", function()
	rejects(Validators.string(), "\255\254")
end)

-- number / integer
test("number rejects NaN and infinity", function()
	rejects(Validators.number(), NAN)
	rejects(Validators.number(), math.huge)
	rejects(Validators.number(), -math.huge)
end)
test("number respects min and max", function()
	local check = Validators.number(0, 10)
	accepts(check, 0)
	accepts(check, 10)
	rejects(check, -0.1)
	rejects(check, 10.1)
end)
test("integer rejects decimals", function()
	accepts(Validators.integer(1, 99), 5)
	rejects(Validators.integer(1, 99), 5.5)
	rejects(Validators.integer(1, 99), 0)
	rejects(Validators.integer(), NAN)
end)

-- boolean / literal / optional
test("boolean only accepts true and false", function()
	accepts(Validators.boolean(), true)
	accepts(Validators.boolean(), false)
	rejects(Validators.boolean(), "true")
	rejects(Validators.boolean(), nil)
end)
test("literal only accepts listed options", function()
	local check = Validators.literal("sword", "bow")
	accepts(check, "bow")
	rejects(check, "axe")
	rejects(check, nil)
end)
test("optional accepts nil or the inner check", function()
	local check = Validators.optional(Validators.integer())
	accepts(check, nil)
	accepts(check, 3)
	rejects(check, "3")
end)

-- object
test("object accepts the exact shape", function()
	local check = Validators.object({ id = Validators.string(), amount = Validators.integer(1, 10) })
	accepts(check, { id = "gem", amount = 2 })
end)
test("object rejects extra keys", function()
	local check = Validators.object({ id = Validators.string() })
	rejects(check, { id = "gem", admin = true })
	rejects(check, { id = "gem", [1] = "x" })
end)
test("object rejects bad or missing fields", function()
	local check = Validators.object({ id = Validators.string(), amount = Validators.integer() })
	rejects(check, { id = "gem" })
	rejects(check, { id = "gem", amount = NAN })
	rejects(check, "not a table")
end)
test("object allows missing optional fields", function()
	local check = Validators.object({ id = Validators.string(), note = Validators.optional(Validators.string()) })
	accepts(check, { id = "gem" })
end)

-- array
test("array accepts a clean list", function()
	accepts(Validators.array(Validators.integer()), { 1, 2, 3 })
	accepts(Validators.array(Validators.integer()), {})
end)
test("array rejects gaps, string keys and long lists", function()
	local check = Validators.array(Validators.integer(), 3)
	rejects(check, { [1] = 1, [3] = 3 })
	rejects(check, { 1, 2, x = 3 })
	rejects(check, { 1, 2, 3, 4 })
	rejects(check, { 1, "2" })
end)

-- validateArgs
test("validateArgs accepts a matching list", function()
	local checks = { Validators.string(), Validators.integer(1, 5) }
	local ok = Validators.validateArgs(checks, 2, { "gem", 3 })
	assert(ok, "expected ok")
end)
test("validateArgs rejects extra arguments", function()
	local checks = { Validators.string() }
	local ok = Validators.validateArgs(checks, 2, { "gem", 3 })
	assert(not ok, "expected rejection")
end)
test("validateArgs rejects a missing required argument", function()
	local checks = { Validators.string(), Validators.integer() }
	local ok = Validators.validateArgs(checks, 1, { "gem" })
	assert(not ok, "expected rejection")
end)

-- RateLimiter
test("RateLimiter allows a burst then blocks", function()
	local now = 0
	local limiter = RateLimiter.new(1, 3, function()
		return now
	end)
	assert(limiter:allow("p1"), "1st")
	assert(limiter:allow("p1"), "2nd")
	assert(limiter:allow("p1"), "3rd")
	assert(not limiter:allow("p1"), "4th should be blocked")
end)
test("RateLimiter refills over time", function()
	local now = 0
	local limiter = RateLimiter.new(2, 1, function()
		return now
	end)
	assert(limiter:allow("p1"), "first")
	assert(not limiter:allow("p1"), "empty")
	now = 0.5
	assert(limiter:allow("p1"), "refilled after 0.5s at 2/s")
end)
test("RateLimiter keeps keys separate", function()
	local limiter = RateLimiter.new(1, 1, function()
		return 0
	end)
	assert(limiter:allow("p1"), "p1")
	assert(limiter:allow("p2"), "p2 has its own bucket")
	assert(not limiter:allow("p1"), "p1 is empty")
end)
test("RateLimiter.remove resets a key", function()
	local limiter = RateLimiter.new(1, 1, function()
		return 0
	end)
	assert(limiter:allow("p1"), "first")
	limiter:remove("p1")
	assert(limiter:allow("p1"), "fresh bucket after remove")
end)

print(`\n{passed} passed, {failed} failed`)
if failed > 0 then
	error("tests failed")
end
