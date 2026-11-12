--!strict
-- Shared definitions: put this ModuleScript in ReplicatedStorage.
-- Both the server and the client require it, so they always agree.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local SafeWire = require(ReplicatedStorage.Packages.SafeWire)
local t = SafeWire.t

return {
	-- Client -> server: buy an item. Only 2 requests per second, bursts of 4.
	BuyItem = SafeWire.event("BuyItem", {
		t.string(40), -- itemId
		t.integer(1, 99), -- quantity
	}, { rate = 2, burst = 4 }),

	-- Client -> server: equip from a fixed list.
	Equip = SafeWire.event("Equip", {
		t.literal("sword", "bow", "staff"),
	}),

	-- Server -> client: show a message. No client input, so no checks needed.
	Notify = SafeWire.event("Notify", {}),
}
