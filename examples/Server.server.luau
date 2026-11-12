--!strict
-- Server script (ServerScriptService).

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Remotes = require(ReplicatedStorage.Remotes)

-- Prices live on the server. Never trust a price sent by the client.
local PRICES: { [string]: number } = {
	potion = 10,
	shield = 50,
}

local coins: { [Player]: number } = {}

Remotes.BuyItem:onServer(function(player: Player, itemId: string, quantity: number)
	-- Types and ranges are already checked. Now check the game rules.
	local price = PRICES[itemId]
	if price == nil then
		return
	end
	local balance = coins[player] or 0
	local cost = price * quantity
	if balance < cost then
		Remotes.Notify:fireClient(player, "Not enough coins")
		return
	end
	coins[player] = balance - cost
	Remotes.Notify:fireClient(player, `Bought {quantity} {itemId}`)
end)

Remotes.Equip:onServer(function(player: Player, weapon: string)
	print(player.Name, "equipped", weapon)
end)
