**Solana Raydium Sniper Bot** that listens to new Raydium USDC or SOL pools and buys tokens for a fixed amount in USDC/SOL.
Depending on the speed of the RPC node, the purchase usually happens before the token is available on Raydium UI for swapping. This version is free, but it can still generate stable profits of several hundred dollars per day. You can run it for a few hours to check the earnings. If you want to purchase the premium version, my Telegram is at the bottom. Note: Even for testing, besides using WSOL as the exchange token, it’s important to keep more SOL for transaction fees. The correct configuration is 0.9 SOL / 0.1 WSOL.

- `WSOL Snipe`
- `Auto-Sell`
- `TP/SL`
- `Min Liq`
- `Burn/Lock Check`
- `Renounce Check`
- `Fast Buy`

## SETUP
To run the script you need to:
1. Create a new empty Solana wallet
2. Transfer some SOL to it
3. Convert some SOL to USDC or WSOL (you need USDC or WSOL depending on the configuration set below)

`Jupiter Wrap` : https://jup.ag/

## CONFIG
1. Configure the script by updating `.env.copy` file (**remove the .copy from the file name when done**).
2. `PRIVATE_KEY` (your wallet private key)
3. `RPC_ENDPOINT` (https RPC endpoint)
4. `RPC_WEBSOCKET_ENDPOINT` (websocket RPC endpoint)
5. `QUOTE_MINT` (which pools to snipe, USDC or WSOL)
6. `QUOTE_AMOUNT` (amount used to buy each new token)
7. `CHECK_IF_MINT_IS_RENOUNCED` (script will buy only if mint is renounced)
8. `MIN_POOL_SIZE` (script will buy only if pool size is greater than specified amount)
9. `TAKE_PROFIT` (in %)
10. `STOP_LOSS` (in %)
11. `USE_JITO` (bot use jito for anti-mev and speed)
12. `JITO_TIP` (jito tip amount)
13. `COMMITMENT_LEVEL` 
14. `BIRDEYE_API_KEY` (TP/SL, Burn/Lock) generate here : https://docs.birdeye.so/docs/authentication-api-keys

 
## INSTALL
1. Install dependencies by typing: `npm install`
2. Run the script by typing: `npm run start` in terminal

## TAKE PROFIT

> [!NOTE]
> By default, 100 % 

## STOP LOSS

> [!NOTE]
> By default, 100 %

## AUTO SELL
By default, auto sell is enabled. If you want to disable it, you need to:
1. Change variable `AUTO_SELL` to `false`
2. Update `MAX_SELL_RETRIES` to set the maximum number of retries for selling token
3. Update `AUTO_SELL_DELAY` to the number of milliseconds you want to wait before selling the token (this will sell the token after the specified delay. (+- RPC node speed)).

If you set AUTO_SELL_DELAY to 0, token will be sold immediately after it is bought.
There is no guarantee that the token will be sold at a profit or even sold at all. The developer is not responsible for any losses incurred by using this feature.

## COMMON ISSUES

> ### EMPTY TRANSACTION
> If you see empty transactions on SolScan most likely fix is to change commitment level to `finalized`.
> 
> ### UNSOPPORTED RPC NODE
> If you see following error in your log file:  
> `Error: 410 Gone:  {"jsonrpc":"2.0","error":{"code": 410, "message":"The RPC call or parameters have been disabled."}, "id": "986f3599-b2b7-47c4-b951-074c19842bad"}`  
> It means your RPC node doesn't support methods needed to execute script.
> FIX: Change your RPC node. You can use Shyft, Helius or Quicknode. 
> 
> ### NO TOKEN ACCOUNT
> If you see following error in your log file:  
> `Error: No SOL token account found in wallet:`  
> it means that wallet you provided doesn't have USDC/WSOL token account.
> FIX: Go to dex and swap some SOL to USDC/WSOL. When you swap sol to wsol you should see it in wallet.

## CONTACT
Telegram: `@powerful115`

## DISCLAIMER

> [!IMPORTANT]
> Use this script at your own risk.
