--!strict
--[[
	Validators
	Small runtime checks for values that arrive over the network.

	Every check has the shape `(value: unknown) -> (boolean, string?)`:
	it returns `true` when the value is acceptable, or `false` plus a short reason.

	This module does not touch any Roblox service, so it can be unit tested
	with the plain Luau CLI.
]]

export type Check = (value: unknown) -> (boolean, string?)

local Validators = {}

local DEFAULT_STRING_LIMIT = 200
local DEFAULT_ARRAY_LIMIT = 100

local function isFiniteNumber(value: number): boolean
	-- NaN is the only value that is not equal to itself.
	return value == value and value ~= math.huge and value ~= -math.huge
end

--- Accepts any string up to `maxLength` bytes (default 200) that is valid UTF-8.
function Validators.string(maxLength: number?): Check
	local limit = maxLength or DEFAULT_STRING_LIMIT
	return function(value: unknown): (boolean, string?)
		if typeof(value) ~= "string" then
			return false, "expected string"
		end
		local text = value :: string
		if #text > limit then
			return false, `string longer than {limit} bytes`
		end
		if utf8.len(text) == nil then
			return false, "string is not valid UTF-8"
		end
		return true
	end
end

--- Accepts a finite number (no NaN, no infinity), optionally inside [min, max].
function Validators.number(min: number?, max: number?): Check
	return function(value: unknown): (boolean, string?)
		if typeof(value) ~= "number" then
			return false, "expected number"
		end
		local n = value :: number
		if not isFiniteNumber(n) then
			return false, "number is NaN or infinite"
		end
		if min ~= nil and n < min then
			return false, `number below {min}`
		end
		if max ~= nil and n > max then
			return false, `number above {max}`
		end
		return true
	end
end

--- Accepts a whole number, optionally inside [min, max].
function Validators.integer(min: number?, max: number?): Check
	local numberCheck = Validators.number(min, max)
	return function(value: unknown): (boolean, string?)
		local ok, reason = numberCheck(value)
		if not ok then
			return false, reason
		end
		local n = value :: number
		if n ~= math.floor(n) then
			return false, "expected integer"
		end
		return true
	end
end

--- Accepts `true` or `false`.
function Validators.boolean(): Check
	return function(value: unknown): (boolean, string?)
		if typeof(value) ~= "boolean" then
			return false, "expected boolean"
		end
		return true
	end
end

--- Accepts only one of the listed values, e.g. `literal("sword", "bow")`.
function Validators.literal(...: string | number | boolean): Check
	local allowed: { [unknown]: boolean } = {}
	for _, option in { ... } do
		allowed[option] = true
	end
	return function(value: unknown): (boolean, string?)
		if allowed[value] then
			return true
		end
		return false, "value is not one of the allowed options"
	end
end

--- Accepts `nil`, or anything `check` accepts.
function Validators.optional(check: Check): Check
	return function(value: unknown): (boolean, string?)
		if value == nil then
			return true
		end
		return check(value)
	end
end

--- Accepts a table with exactly these string keys. Unknown keys are rejected.
function Validators.object(shape: { [string]: Check }): Check
	return function(value: unknown): (boolean, string?)
		if typeof(value) ~= "table" then
			return false, "expected table"
		end
		local tbl = value :: { [unknown]: unknown }
		for key in tbl do
			if typeof(key) ~= "string" or shape[key :: string] == nil then
				return false, "table has an unexpected key"
			end
		end
		for key, check in shape do
			local ok, reason = check(tbl[key])
			if not ok then
				return false, `field "{key}": {reason or "invalid"}`
			end
		end
		return true
	end
end

--- Accepts a list (keys 1..n, no gaps) of at most `maxLength` items (default 100),
--- where every item passes `check`.
function Validators.array(check: Check, maxLength: number?): Check
	local limit = maxLength or DEFAULT_ARRAY_LIMIT
	return function(value: unknown): (boolean, string?)
		if typeof(value) ~= "table" then
			return false, "expected array"
		end
		local tbl = value :: { [unknown]: unknown }
		local count = 0
		for key in tbl do
			if typeof(key) ~= "number" then
				return false, "array has a non-number key"
			end
			local index = key :: number
			if index < 1 or index > limit or index ~= math.floor(index) then
				return false, "array index out of range"
			end
			count += 1
		end
		for index = 1, count do
			local item = tbl[index]
			if item == nil then
				return false, "array has gaps"
			end
			local ok, reason = check(item)
			if not ok then
				return false, `item {index}: {reason or "invalid"}`
			end
		end
		return true
	end
end

--- Accepts an Instance that `IsA(className)`.
--- Remember: the client can send any instance it can see. Still check that the
--- player is allowed to act on it (distance, ownership, state) in your handler.
function Validators.instanceOf(className: string): Check
	return function(value: unknown): (boolean, string?)
		if typeof(value) ~= "Instance" then
			return false, "expected Instance"
		end
		local instance = value :: Instance
		if not instance:IsA(className) then
			return false, `expected {className}`
		end
		return true
	end
end

--- Accepts a Vector3 with finite components, and an optional maximum magnitude.
function Validators.vector3(maxMagnitude: number?): Check
	return function(value: unknown): (boolean, string?)
		if typeof(value) ~= "Vector3" then
			return false, "expected Vector3"
		end
		local v = value :: Vector3
		if not (isFiniteNumber(v.X) and isFiniteNumber(v.Y) and isFiniteNumber(v.Z)) then
			return false, "Vector3 has NaN or infinite parts"
		end
		if maxMagnitude ~= nil and v.Magnitude > maxMagnitude then
			return false, `Vector3 longer than {maxMagnitude}`
		end
		return true
	end
end

--- Checks a full argument list against a list of checks.
--- `count` is `select("#", ...)` so trailing nils and extra arguments are both caught.
function Validators.validateArgs(checks: { Check }, count: number, values: { unknown }): (boolean, string?)
	if count > #checks then
		return false, `too many arguments (got {count}, expected at most {#checks})`
	end
	for index, check in checks do
		local ok, reason = check(values[index])
		if not ok then
			return false, `argument {index}: {reason or "invalid"}`
		end
	end
	return true
end

return Validators
