--!strict
--[[
	SafeWire
	Validated, rate-limited RemoteEvents for Roblox.

	Define every event once in a shared module, then use the same definition
	on the server and on the client:

		local SafeWire = require(path.to.SafeWire)
		local t = SafeWire.t

		return {
			BuyItem = SafeWire.event("BuyItem", { t.string(40), t.integer(1, 99) }, { rate = 2, burst = 4 }),
		}

	The server only runs your handler after the arguments passed every check
	and the player is inside the rate limit. Everything else is dropped.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local RateLimiter = require(script.RateLimiter)
local Validators = require(script.Validators)

export type Check = Validators.Check

export type EventOptions = {
	--- Tokens returned per second for each player. Default 10.
	rate: number?,
	--- Largest burst a player can send at once. Default 20.
	burst: number?,
	--- Called on the server when a request is dropped. Useful for logging.
	onReject: ((player: Player, reason: string) -> ())?,
}

local FOLDER_NAME = "SafeWireRemotes"
local DEFAULT_RATE = 10
local DEFAULT_BURST = 20

local Event = {}
Event.__index = Event

type EventData = {
	name: string,
	checks: { Check },
	limiter: RateLimiter.RateLimiter,
	onReject: ((player: Player, reason: string) -> ())?,
	remote: RemoteEvent?,
	hasServerHandler: boolean,
}

export type Event = typeof(setmetatable({} :: EventData, Event))

local registered: { [string]: boolean } = {}

local function getFolder(): Folder
	if RunService:IsServer() then
		local existing = ReplicatedStorage:FindFirstChild(FOLDER_NAME)
		if existing then
			assert(existing:IsA("Folder"), `ReplicatedStorage.{FOLDER_NAME} must be a Folder`)
			return existing
		end
		local folder = Instance.new("Folder")
		folder.Name = FOLDER_NAME
		folder.Parent = ReplicatedStorage
		return folder
	end
	local folder = ReplicatedStorage:WaitForChild(FOLDER_NAME)
	assert(folder:IsA("Folder"), `ReplicatedStorage.{FOLDER_NAME} must be a Folder`)
	return folder
end

local function getRemote(self: Event): RemoteEvent
	local cached = self.remote
	if cached then
		return cached
	end
	local folder = getFolder()
	local remote: RemoteEvent
	if RunService:IsServer() then
		local existing = folder:FindFirstChild(self.name)
		if existing then
			assert(existing:IsA("RemoteEvent"), `SafeWire: "{self.name}" exists but is not a RemoteEvent`)
			remote = existing
		else
			local created = Instance.new("RemoteEvent")
			created.Name = self.name
			created.Parent = folder
			remote = created
		end
	else
		local found = folder:WaitForChild(self.name)
		assert(found:IsA("RemoteEvent"), `SafeWire: "{self.name}" is not a RemoteEvent`)
		remote = found
	end
	self.remote = remote
	return remote
end

local function reject(self: Event, player: Player, reason: string)
	local onReject = self.onReject
	if onReject then
		onReject(player, reason)
	elseif RunService:IsStudio() then
		warn(`[SafeWire] dropped "{self.name}" from {player.Name}: {reason}`)
	end
end

--- Creates an event definition. Call it from a shared module that both sides require.
local function newEvent(name: string, checks: { Check }, options: EventOptions?): Event
	assert(typeof(name) == "string" and #name > 0, "SafeWire.event: name must be a non-empty string")
	assert(not registered[name], `SafeWire.event: "{name}" is already defined`)
	registered[name] = true

	local opts: EventOptions = options or {}
	local data: EventData = {
		name = name,
		checks = checks,
		limiter = RateLimiter.new(opts.rate or DEFAULT_RATE, opts.burst or DEFAULT_BURST),
		onReject = opts.onReject,
		remote = nil,
		hasServerHandler = false,
	}
	local self = setmetatable(data, Event)

	-- The server creates the RemoteEvent right away so clients never wait forever.
	if RunService:IsServer() then
		getRemote(self)
	end
	return self
end

--- Server: runs `handler` only for requests that pass the rate limit and every check.
--- One handler per event, so the rate limit is counted once per request.
function Event.onServer(self: Event, handler: (player: Player, ...any) -> ()): RBXScriptConnection
	assert(RunService:IsServer(), "SafeWire: onServer can only be used on the server")
	assert(not self.hasServerHandler, `SafeWire: "{self.name}" already has a server handler`)
	self.hasServerHandler = true

	Players.PlayerRemoving:Connect(function(player: Player)
		self.limiter:remove(player)
	end)

	return getRemote(self).OnServerEvent:Connect(function(player: Player, ...: unknown)
		if not self.limiter:allow(player) then
			reject(self, player, "rate limited")
			return
		end
		local ok, reason = Validators.validateArgs(self.checks, select("#", ...), { ... })
		if not ok then
			reject(self, player, reason or "invalid arguments")
			return
		end
		handler(player, ...)
	end)
end

--- Server: sends to one player.
function Event.fireClient(self: Event, player: Player, ...: any)
	assert(RunService:IsServer(), "SafeWire: fireClient can only be used on the server")
	getRemote(self):FireClient(player, ...)
end

--- Server: sends to every player.
function Event.fireAllClients(self: Event, ...: any)
	assert(RunService:IsServer(), "SafeWire: fireAllClients can only be used on the server")
	getRemote(self):FireAllClients(...)
end

--- Client: sends a request to the server.
--- Arguments are checked here too, so mistakes show up during development.
--- This is only a convenience: the server always checks again.
function Event.fire(self: Event, ...: any)
	assert(RunService:IsClient(), "SafeWire: fire can only be used on the client")
	local ok, reason = Validators.validateArgs(self.checks, select("#", ...), { ... })
	if not ok then
		error(`SafeWire: "{self.name}" {reason or "invalid arguments"}`, 2)
	end
	getRemote(self):FireServer(...)
end

--- Client: listens for messages from the server.
function Event.onClient(self: Event, handler: (...any) -> ()): RBXScriptConnection
	assert(RunService:IsClient(), "SafeWire: onClient can only be used on the client")
	return getRemote(self).OnClientEvent:Connect(handler)
end

return {
	event = newEvent,
	t = Validators,
	RateLimiter = RateLimiter,
}
