import {
  BigNumberish,
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4, // Raydium liquidity pool layout (version 4)
  LiquidityPoolKeys, // Structure representing a Raydium liquidity pool
  LiquidityStateV4, // Raydium liquidity pool state (version 4)
  MARKET_STATE_LAYOUT_V3, // OpenBook market layout (version 3)
  MarketStateV3, // OpenBook market state (version 3)
  Token, // Token object for handling Solana tokens
  TokenAmount, // Helper class for handling token amounts with proper formatting
} from '@raydium-io/raydium-sdk'; // Raydium SDK for interacting with liquidity pools
import {
  AccountLayout, // SPL Token account layout
  createAssociatedTokenAccountIdempotentInstruction, // Creates an associated token account if it doesn't already exist
  createCloseAccountInstruction, // Closes a token account
  getAssociatedTokenAddressSync, // Returns the associated token address (ATA) for a wallet
  TOKEN_PROGRAM_ID, // Program ID for Solana's SPL token program
} from '@solana/spl-token'; // Solana's SPL token standard library
import {
  Keypair, // Solana keypair (private and public key pair)
  Connection, // Handles connection to the Solana blockchain
  PublicKey, // Public key type for Solana addresses
  ComputeBudgetProgram, // Used for adjusting compute budget in transactions
  KeyedAccountInfo, // Solana's account info structure for events
  TransactionMessage, // Message object for building and signing transactions
  VersionedTransaction, // Structure for handling transactions (versioned)
  Commitment, // Defines the commitment level for transactions (finality of the blockchain state)
} from '@solana/web3.js'; // Solana's core web3 SDK
import { 
  getTokenAccounts, // Utility function for getting token accounts
  RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, // Raydium's liquidity program ID (v4)
  OPENBOOK_PROGRAM_ID, // OpenBook's program ID
  createPoolKeys // Helper function for creating pool keys for liquidity pools
} from './liquidity'; // Custom liquidity pool helper functions
import { 
  DefaultTransactionExecutor, // Default transaction executor
  JitoTransactionExecutor // Jito service transaction executor (used for MEV protection)
} from './transactions'; // Helper classes for transaction execution
import { retrieveEnvVariable, retrieveTokenValueByAddress } from './utils'; // Utility functions
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market'; // Market helper functions
import { MintLayout } from './types'; // Data layout for mint accounts
import pino from 'pino'; // Pino logging library for structured logging
import bs58 from 'bs58'; // Helper for encoding/decoding in base58 format (Solana keys)
import * as fs from 'fs'; // Node.js file system module
import * as path from 'path'; // Node.js path module

// Logger setup
const transport = pino.transport({
  targets: [
    {
      level: 'trace', // Log everything from 'trace' and above
      target: 'pino-pretty', // Pretty printing for log output
      options: {},
    },
  ],
});

// Logger instance with configuration
export const logger = pino(
  {
    level: 'trace', // Log level
    redact: ['poolKeys'], // Redact sensitive fields like poolKeys
    serializers: {
      error: pino.stdSerializers.err, // Use Pino's built-in error serializer
    },
    base: undefined, // No base field in log messages
  },
  transport,
);

// Constants for the Solana network and RPC endpoints
const network = 'mainnet-beta'; // Mainnet network
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger); // Get the RPC endpoint from environment variables
const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger); // Get the WebSocket endpoint for Solana

// Connection to the Solana network with WebSocket support
const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

// Data structure for storing minimal token account data
export type MinimalTokenAccountData = {
  mint: PublicKey; // Mint address (token ID)
  address: PublicKey; // Associated token account address
  buyValue?: number; // Price at which the token was bought
  poolKeys?: LiquidityPoolKeys; // Liquidity pool keys (if applicable)
  market?: MinimalMarketLayoutV3; // Market data for the token
};

// Data structures for tracking liquidity pools, markets, and token accounts
let existingLiquidityPools: Set<string> = new Set<string>(); // Set of existing liquidity pools (by ID)
let existingOpenBookMarkets: Set<string> = new Set<string>(); // Set of existing OpenBook markets (by ID)
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>(); // Map of token accounts

// Variables related to the wallet and the quote token (e.g., USDC or WSOL)
let wallet: Keypair; // Wallet (keypair) for the bot
let quoteToken: Token; // Quote token (USDC/WSOL) used for trading
let quoteTokenAssociatedAddress: PublicKey; // Associated token account address for the quote token
let quoteAmount: TokenAmount; // Amount of quote token to use for trades
let quoteMinPoolSizeAmount: TokenAmount; // Minimum pool size for liquidity pools
let commitment: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment; // Commitment level for transactions

// Configuration for take profit, stop loss, and other trading settings
const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger)); // Take profit percentage
const STOP_LOSS = Number(retrieveEnvVariable('STOP_LOSS', logger)); // Stop loss percentage
const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED', logger) === 'true'; // Check if the minting authority is renounced
const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true'; // Enable auto-sell after buying
const AUTO_SELL_DELAY = retrieveEnvVariable('AUTO_SELL_DELAY', logger) === 'true'; // Bot sell token automatically after delay time
const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger)); // Maximum retries for sell orders
const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger); // Minimum liquidity pool size
const USE_JITO = retrieveEnvVariable('USE_JITO', logger) === 'true'; // Use Jito service for MEV protection
const JITO_TIP = retrieveEnvVariable('JITO_TIP', logger); // Tip amount for Jito transactions

// Initialize the bot and wallet
async function init(): Promise<void> {
  logger.info(`
######## RAYDIUM SNIPER BOT - USE AT YOUR OWN RISK #########
--------------- RUNNING | CTRL+C TO STOP IT ----------------
`);

  // Get wallet private key from environment variables and create keypair
  const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

  logger.info(`CONNECTED @ ${RPC_ENDPOINT}`);
  logger.info('----------------------------------------------------------');
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // Get quote token (either WSOL or USDC) and the amount to use for trades
  const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
  const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);

  // Switch between WSOL and USDC as the quote token
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL; // Use WSOL as the quote token
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false); // Set the amount of WSOL to use
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false); // Set the minimum pool size for WSOL pools
      break;
    }
    case 'USDC': {
      quoteToken = new Token( // Use USDC as the quote token
        TOKEN_PROGRAM_ID, // SPL Token program ID
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC mint address on Solana
        6, // Decimal places for USDC
        'USDC', // Symbol for USDC
        'USDC', // Name for USDC
      );
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false); // Set the amount of USDC to use
      break;
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`);
    }
  }

  // Logging of bot configuration details
  logger.info(`Check mint renounced: ${CHECK_IF_MINT_IS_RENOUNCED}`);
  logger.info(
    `Min pool size: ${quoteMinPoolSizeAmount.isZero() ? 'false' : quoteMinPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
  );
  logger.info(`Buy amount: ${quoteAmount.toFixed()} ${quoteToken.symbol}`);
  logger.info(`Auto sell: ${AUTO_SELL}`);
  logger.info(`T/P: ${TAKE_PROFIT}%`);
  logger.info(`S/L: ${STOP_LOSS}%`);

  // Check the wallet for an associated token account for the quote token
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint, // Mint address for the token account
      address: ta.pubkey, // Address of the token account
    });
  }

  const tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString())!;

  // If no token account is found for the quote token, throw an error
  if (!tokenAccount) {
    throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
  }

  quoteTokenAssociatedAddress = tokenAccount.pubkey; // Store the associated token address for the quote token
}

// Save the token account data
function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey); // Get the associated token address for the mint
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata, // Associated token account address
    mint: mint, // Mint address for the token
    market: <MinimalMarketLayoutV3>{ // Market data for the token
      bids: accountData.bids, // Market bids
      asks: accountData.asks, // Market asks
      eventQueue: accountData.eventQueue, // Event queue for the market
    },
  };
  existingTokenAccounts.set(mint.toString(), tokenAccount); // Save the token account data in the map
  return tokenAccount;
}

// Process Raydium pools when they are discovered
export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  if (CHECK_IF_MINT_IS_RENOUNCED) {
    const mintOption = await checkMintable(poolState.baseMint); // Check if the mint authority is renounced

    if (mintOption !== true) {
      logger.warn({ mint: poolState.baseMint }, 'Skipping, owner can mint tokens!');
      return; // Skip the pool if minting authority is not renounced
    }
  }

  // Check the pool size and log pool details
  if (!quoteMinPoolSizeAmount.isZero()) {
    const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
    const poolTokenAddress = poolState.baseMint.toString();

    if (poolSize.lt(quoteMinPoolSizeAmount)) {
      logger.warn(`------------------- POOL SKIPPED | (${poolSize.toFixed()} ${quoteToken.symbol}) ------------------- `);
    } else {
      logger.info(`--------------!!!!! POOL SNIPED | (${poolSize.toFixed()} ${quoteToken.symbol}) !!!!!-------------- `);
    }

    logger.info(`Pool link: https://dexscreener.com/solana/${id.toString()}`);
    logger.info(`Pool Open Time: ${new Date(parseInt(poolState.poolOpenTime.toString()) * 1000).toLocaleString()}`);
    logger.info(`--------------------- `);

    if (poolSize.lt(quoteMinPoolSizeAmount)) {
      return; // Skip if pool size is too small
    }

    logger.info(`Pool ID: ${id.toString()}`);
    logger.info(`Pool link: https://dexscreener.com/solana/${id.toString()}`);
    logger.info(`Pool SOL size: ${poolSize.toFixed()} ${quoteToken.symbol}`);
    logger.info(`Base Mint: ${poolState.baseMint}`);
    logger.info(`Pool Status: ${poolState.status}`);
  }

  // Buy the token in the pool
  await buy(id, poolState);
}

// Check if a token's mint authority has been renounced (i.e., no one can mint new tokens)
export async function checkMintable(vault: PublicKey): Promise<boolean | undefined> {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {};
    if (!data) {
      return;
    }
    const deserialize = MintLayout.decode(data); // Decode the mint account data
    return deserialize.mintAuthorityOption === 0; // Return true if minting authority is renounced
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: vault }, `Failed to check if mint is renounced`);
  }
}

// Process OpenBook markets when they are discovered
export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data); // Decode the market data

    // Save the market data if it doesn't already exist in the map
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }

    saveTokenAccount(accountData.baseMint, accountData); // Save the token account for the market
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: accountData?.baseMint }, `Failed to process market`);
  }
}

// Buy tokens from a Raydium liquidity pool
async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {
  try {
    // Choose between Jito (for MEV protection) and default transaction executor
    const txExecutor = USE_JITO
      ? new JitoTransactionExecutor(JITO_TIP.toString(), solanaConnection)
      : new DefaultTransactionExecutor(solanaConnection);

    let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());

    if (!tokenAccount) {
      const market = await getMinimalMarketV3(solanaConnection, accountData.marketId, commitment); // Get minimal market data
      tokenAccount = saveTokenAccount(accountData.baseMint, market); // Save the token account
    }

    // Create liquidity pool keys for the token
    tokenAccount.poolKeys = createPoolKeys(accountId, accountData, tokenAccount.market!);

    // Build the swap instruction for buying the token
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: tokenAccount.poolKeys,
        userKeys: {
          tokenAccountIn: quoteTokenAssociatedAddress, // The account holding the quote token (e.g., WSOL or USDC)
          tokenAccountOut: tokenAccount.address, // The account receiving the bought tokens
          owner: wallet.publicKey, // The wallet that owns the transaction
        },
        amountIn: quoteAmount.raw, // The amount of quote token to use for the swap
        minAmountOut: 0, // No minimum amount of tokens to receive
      },
      tokenAccount.poolKeys.version,
    );

    // Get the latest blockhash for building the transaction
    const latestBlockhash = await solanaConnection.getLatestBlockhash({
      commitment: commitment,
    });

    // Build a versioned transaction with the swap instruction
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey, // The wallet paying for the transaction
      recentBlockhash: latestBlockhash.blockhash, // Latest blockhash for the transaction
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }), // Adjust the compute budget
        ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }), // Set compute unit limit
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey, // Wallet creating the associated token account
          tokenAccount.address, // The associated token account address
          wallet.publicKey, // Wallet that owns the token account
          accountData.baseMint, // The mint of the token being bought
        ),
        ...innerTransaction.instructions, // Add the swap instructions
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0); // Create the transaction
    transaction.sign([wallet, ...innerTransaction.signers]); // Sign the transaction

    const { confirmed, signature } = await txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash); // Send and confirm the transaction

    // Check the balances of the base and quote vaults in the liquidity pool
    const basePromise = solanaConnection.getTokenAccountBalance(accountData.baseVault, commitment);
    const quotePromise = solanaConnection.getTokenAccountBalance(accountData.quoteVault, commitment);

    await Promise.all([basePromise, quotePromise]); // Wait for both promises to resolve

    const baseValue = await basePromise;
    const quoteValue = await quotePromise;

    // Calculate the buy price and log the result
    if (baseValue?.value?.uiAmount && quoteValue?.value?.uiAmount)
      tokenAccount.buyValue = quoteValue?.value?.uiAmount / baseValue?.value?.uiAmount;

    if (confirmed === true) {
      logger.info(
        {
          signature,
          url: `https://solscan.io/tx/${signature}?cluster=${network}`,
          dex: `https://dexscreener.com/solana/${accountData.baseMint}?maker=${wallet.publicKey}`,
        },
        `Confirmed buy tx... Bought at: ${tokenAccount.buyValue} SOL`,
      );

      
      // Schedule automatic sell after the AUTO_SELL_DELAY
      const autoSellDelay = Number(retrieveEnvVariable('AUTO_SELL_DELAY', logger));
      setTimeout(async () => await scheduleAutoSell(accountData), autoSellDelay);

    } else {
      logger.info({ mint: accountData.baseMint, signature }, `Error confirming buy tx`);
    }
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: accountData.baseMint }, `Failed to buy token`);
  }
}

// Function to handle automatic selling with retry logic
async function scheduleAutoSell(accountData: LiquidityStateV4) {
  let completed = false;
  let retries = 0;

  try {
    while (!completed && retries < MAX_SELL_RETRIES) {
      retries++;
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Sleep for 1 second before retry

      const currValue = await retrieveTokenValueByAddress(accountData.baseMint.toBase58());
      if (currValue) {
        logger.info(accountData.baseMint, `Scheduled Auto Sell. Current Price: ${currValue} SOL`);

        const tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());
        if (tokenAccount) {
          const tokenAccountBalance = await solanaConnection.getTokenAccountBalance(tokenAccount.address, commitment);
          const sellAmount = tokenAccountBalance.value.amount;

          logger.info(accountData.baseMint, `Preparing to sell ${sellAmount} tokens at current value of ${currValue} SOL`);
          completed = await sell(accountData.baseMint, sellAmount, currValue);
        } else {
          logger.warn(accountData.baseMint, `Token account not found`);
        }
      } else {
        logger.warn(accountData.baseMint, `Could not retrieve current token value`);
      }
    }

    if (!completed) {
      logger.error('Max retries reached for token sell');
    }
  } catch (e) {
    logger.error(`Error during auto-sell process: ${e}`);
  }
}

// Sell tokens from a liquidity pool
async function sell(mint: PublicKey, amount: BigNumberish, value: number): Promise<boolean> {
  let retries = 0;
  const txExecutor = USE_JITO
    ? new JitoTransactionExecutor(JITO_TIP.toString(), solanaConnection)
    : new DefaultTransactionExecutor(solanaConnection);

  do {
    try {
      const tokenAccount = existingTokenAccounts.get(mint.toString());
      if (!tokenAccount) {
        return true;
      }

      if (!tokenAccount.poolKeys) {
        logger.warn({ mint }, 'No pool keys found');
        continue;
      }

      if (amount === 0) {
        logger.info(
          {
            mint: tokenAccount.mint,
          },
          `Empty balance, can't sell`,
        );
        return true;
      }

      // Check the stop loss and take profit conditions
      if (tokenAccount.buyValue === undefined) return true;

      const netChange = (value - tokenAccount.buyValue) / tokenAccount.buyValue;
      if (netChange > STOP_LOSS && netChange < TAKE_PROFIT) return false;

      // Create the swap instruction for selling the token
      const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys: tokenAccount.poolKeys!,
          userKeys: {
            tokenAccountOut: quoteTokenAssociatedAddress,
            tokenAccountIn: tokenAccount.address,
            owner: wallet.publicKey,
          },
          amountIn: amount,
          minAmountOut: 0,
        },
        tokenAccount.poolKeys!.version,
      );

      // Get the latest blockhash and build the transaction
      const latestBlockhash = await solanaConnection.getLatestBlockhash({
        commitment: commitment,
      });
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400000 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
          ...innerTransaction.instructions,
          createCloseAccountInstruction(tokenAccount.address, wallet.publicKey, wallet.publicKey),
        ],
      }).compileToV0Message();
      
      const transaction = new VersionedTransaction(messageV0); // Build versioned transaction
      transaction.sign([wallet, ...innerTransaction.signers]); // Sign the transaction

      const { confirmed, signature } = await txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash); // Send and confirm the transaction

      if (confirmed !== false) {
        retries++;
        logger.info({ mint, signature }, `Error confirming sell tx`);
        continue;
      }

      // Log the confirmed sell transaction
      logger.info(
        {
          mint,
          signature,
          url: `https://solscan.io/tx/${signature}?cluster=${network}`,
          dex: `https://dexscreener.com/solana/${mint}?maker=${wallet.publicKey}`,
        },
        `Confirmed sell tx... Sold at: ${value}\tNet Profit: ${netChange * 100}%`,
      );

      return true;
    } catch (e: any) {
      retries++;
      logger.debug(e);
      logger.error({ mint }, `Failed to sell token, retry: ${retries}/${MAX_SELL_RETRIES}`);
    }
  } while (retries < MAX_SELL_RETRIES);
  return true;
}

// Main function that listens for Raydium and OpenBook market changes and executes the bot logic
const runListener = async () => {
  await init(); // Initialize the bot
  const runTimestamp = Math.floor(new Date().getTime() / 1000); // Timestamp for tracking pool opening

  // Listen for Raydium liquidity pool changes
  const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data); // Decode pool state
      const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
      const existing = existingLiquidityPools.has(key);

      if (poolOpenTime > runTimestamp && !existing) {
        existingLiquidityPools.add(key); // Add pool to the existing pools
        const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState); // Process the pool
      }
    },
    commitment,
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span }, // Filter based on the size of the account data
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'), // Filter based on the quote mint
          bytes: quoteToken.mint.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'), // Filter based on the market program ID
          bytes: OPENBOOK_PROGRAM_ID.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'), // Filter based on the pool's status
          bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
        },
      },
    ],
  );

  // Listen for OpenBook market changes
  const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingOpenBookMarkets.has(key);
      if (!existing) {
        existingOpenBookMarkets.add(key); // Add market to existing markets
        const _ = processOpenBookMarket(updatedAccountInfo); // Process the market
      }
    },
    commitment,
    [
      { dataSize: MARKET_STATE_LAYOUT_V3.span }, // Filter based on the size of the account data
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'), // Filter based on the quote mint
          bytes: quoteToken.mint.toBase58(),
        },
      },
    ],
  );

  // If auto-sell is enabled, listen for wallet changes
  if (AUTO_SELL) {
    const walletSubscriptionId = solanaConnection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data); // Decode account data
        if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
          return;
        }
        let completed = false;
        while (!completed) {
          setTimeout(() => {}, 1000); // Wait for 1 second before retrying
          const currValue = await retrieveTokenValueByAddress(accountData.mint.toBase58()); // Retrieve the current token value
          if (currValue) {
            logger.info(accountData.mint, `Current Price: ${currValue} SOL`);
            logger.info(`accountData.amount = ${accountData.amount}`);
            completed = await sell(accountData.mint, accountData.amount, currValue); // Attempt to sell
          } 
        }
      },
      commitment,
      [
        {
          dataSize: 165, // SPL Token account data size
        },
        {
          memcmp: {
            offset: 32, // Offset to compare wallet public keys
            bytes: wallet.publicKey.toBase58(),
          },
        },
      ],
    );

    logger.info(`Listening for wallet changes: ${walletSubscriptionId}`);
  }

  // Log the subscription IDs for the Raydium and OpenBook listeners
  logger.info(`Listening for raydium changes: ${raydiumSubscriptionId}`);
  logger.info(`Listening for open book changes: ${openBookSubscriptionId}`);
};

// Run the listener
runListener();
