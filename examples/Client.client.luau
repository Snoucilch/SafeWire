--!strict
-- LocalScript (StarterPlayerScripts).

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Remotes = require(ReplicatedStorage.Remotes)

Remotes.Notify:onClient(function(message: string)
	print("[Server]", message)
end)

Remotes.Equip:fire("sword")
Remotes.BuyItem:fire("potion", 2)
