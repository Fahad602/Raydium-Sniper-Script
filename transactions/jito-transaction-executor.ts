import {
  BlockhashWithExpiryBlockHeight,
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import axios, { AxiosError } from 'axios';
import bs58 from 'bs58';
import fs from "fs";
import { Currency, CurrencyAmount } from '@raydium-io/raydium-sdk';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import { Bundle } from "jito-ts/dist/sdk/block-engine/types.js";
import { onBundleResult, sendBundle } from "./bundleResults";

export class JitoTransactionExecutor implements TransactionExecutor {
  // https://jito-labs.gitbook.io/mev/searcher-resources/json-rpc-api-reference/bundles/gettipaccounts
  private jitpTipAccounts = [
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  ];

  private JitoFeeWallet: PublicKey;

  constructor(
    private readonly jitoFee: string,
    private readonly connection: Connection,
  ) {
    this.JitoFeeWallet = this.getRandomValidatorKey();
  }

  private getRandomValidatorKey(): PublicKey {
    const randomValidator = this.jitpTipAccounts[Math.floor(Math.random() * this.jitpTipAccounts.length)];
    return new PublicKey(randomValidator);
  }

  public async executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockhash: BlockhashWithExpiryBlockHeight
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }> {

    this.JitoFeeWallet = this.getRandomValidatorKey(); // Update wallet key each execution

    try {
      let fee = new CurrencyAmount(Currency.SOL, this.jitoFee, false).raw.toNumber();
      // const { value: simulationResult } = await this.connection.simulateTransaction(transaction);
      // if (simulationResult.err) {
      //     console.error('Simulation failed for create transaction, written to errorLog.txt');
      //     fs.appendFileSync('errorLog.txt', JSON.stringify(simulationResult, null, 2));
      //     return { confirmed: false };
      // }

      const jitTipTxFeeMessage = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: this.JitoFeeWallet,
            lamports: fee,
          }),
        ],
      }).compileToV0Message();

      const jitoFeeTx = new VersionedTransaction(jitTipTxFeeMessage);
      jitoFeeTx.sign([payer]);

      const searcher = searcherClient("ny.mainnet.block-engine.jito.wtf");
      const bund = new Bundle([], 5);

      if (transaction) {
        bund.addTransactions(transaction);
        bund.addTransactions(jitoFeeTx);
      }

      // let isLeaderSlot = false
      // while (!isLeaderSlot){
      //     let next_leader = await searcher.getNextScheduledLeader()
      //     let num_slots = next_leader.nextLeaderSlot - next_leader.currentSlot;
      //     isLeaderSlot = num_slots <= 2;
      //     console.log(`next jito leader slot in ${num_slots} slots`);
      //     await new Promise(r => setTimeout(r, 500));
      // }

      const res = await sendBundle(searcher, bund);
      if (!res) {
          console.log('Failed to send bundle');
          return { confirmed: false };
      }

      console.log(`Confirm Bundle (JITO): https://explorer.jito.wtf/bundle/${res}`);

      const signature = bs58.encode(transaction.signatures[0]);

      // wait for the bundle to be confirmed
      const [state, listener, timeout] = await onBundleResult(searcher, signature, res, this.connection);

      if (state === 0) {  // If state is 0, it means the bundle wasn't confirmed successfully
        console.log('Bundle confirmation failed.');
        return { confirmed: false };
      }

      return { confirmed: true, signature };

    } catch (error) {
      console.log('Failed to execute jito transaction: ', error);
      return { confirmed: false };
    }
  }
}
