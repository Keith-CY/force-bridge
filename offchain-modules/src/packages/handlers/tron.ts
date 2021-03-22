import { TronDb } from '../db';
import { logger } from '../utils/logger';
import { asyncSleep } from '../utils';
import { ForceBridgeCore } from '../core';
import { ITronLock, TronUnlock, ICkbMint } from '@force-bridge/db/model';
import { ChainType } from '@force-bridge/ckb/model/asset';
const TronWeb = require('tronweb');
const TronGrid = require('trongrid');

type TronLockEvent = {
  tx_hash: string;
  index: number;
  sender: string;
  asset: string;
  amount: string;
  memo: string;
  timestamp: number;
};

export class TronHandler {
  private tronWeb;
  private tronGrid;
  private committee;
  constructor(private db: TronDb) {
    this.tronWeb = new TronWeb({ fullHost: ForceBridgeCore.config.tron.tronGridUrl });
    this.tronGrid = new TronGrid(this.tronWeb);
    this.committee = ForceBridgeCore.config.tron.committee;
  }

  private async getTrxAndTrc10LockEvents(min_timestamp: number): Promise<TronLockEvent[]> {
    const txs = await this.tronGrid.account.getTransactions(this.committee.address, {
      only_to: true,
      only_confirmed: true,
      min_timestamp: min_timestamp,
    });

    const lockEvents: TronLockEvent[] = [];
    for (const data of txs.data) {
      const asset_data = data.raw_data.contract[0].parameter.value;
      const event = {
        tx_hash: data.txID,
        index: 0,
        sender: this.tronWeb.address.fromHex(asset_data.owner_address),
        asset: asset_data.asset_name ? asset_data.asset_name : 'trx',
        amount: asset_data.amount,
        memo: this.tronWeb.toUtf8(data.raw_data.data),
        timestamp: data.block_timestamp,
      };
      lockEvents.push(event);
    }
    return lockEvents;
  }

  private async getTrc20TxsLockEvents(min_timestamp: number): Promise<TronLockEvent[]> {
    const txs = await this.tronGrid.account.getTrc20Transactions(this.committee.address, {
      only_confirmed: true,
      only_to: true,
      min_timestamp: min_timestamp,
    });

    const lockEvents: TronLockEvent[] = [];
    for (const data of txs.data) {
      const tx = await this.tronWeb.trx.getTransaction(data.transaction_id);
      const event = {
        tx_hash: data.transaction_id,
        index: 0,
        sender: data.from,
        asset: this.tronWeb.address.fromHex(data.token_info).address,
        amount: data.value,
        memo: this.tronWeb.toUtf8(tx.raw_data.data),
        timestamp: data.block_timestamp,
      };
      lockEvents.push(event);
    }
    return lockEvents;
  }

  // memo style should be "ckb_recipient,sudt_extra_data"
  private analyzeMemo(memo: string) {
    const splitted = memo.split(',', 2);
    const ckbRecipient = splitted[0];
    const sudtExtraData = splitted[1];

    //todo, check ckb_address valid
    return { ckbRecipient, sudtExtraData };
  }

  private transferEventToCkbMint(event: TronLockEvent) {
    const { ckbRecipient, sudtExtraData } = this.analyzeMemo(event.memo);
    return {
      id: event.tx_hash.concat('_').concat(event.index.toString()),
      chain: ChainType.TRON,
      asset: event.asset,
      amount: event.amount,
      recipientLockscript: ckbRecipient,
      sudtExtraData: sudtExtraData,
    };
  }

  private transferEventToTronLock(event: TronLockEvent) {
    const tronLock = {
      txHash: event.tx_hash,
      txIndex: 0,
      sender: event.sender,
      asset: event.asset,
      assetType: event.asset,
      amount: event.amount,
      memo: event.memo,
      timestamp: event.timestamp,
    };
    return tronLock;
  }

  // listen Tron chain and handle the new lock events
  async watchLockEvents(): Promise<void> {
    while (true) {
      logger.debug('get new lock events and save to db');

      const minTimestamp = await this.db.getLatestTimestamp();

      const ckbMintRecords: ICkbMint[] = [];
      const tronLockRecords: ITronLock[] = [];
      const trxAndTrc10Events = await this.getTrxAndTrc10LockEvents(minTimestamp);
      const trc20LockEvents = await this.getTrc20TxsLockEvents(minTimestamp);
      const totalLockEvents = trxAndTrc10Events.concat(trc20LockEvents);

      for (const event of totalLockEvents) {
        if (event.timestamp < minTimestamp) {
          continue;
        }
        const ckbMint = this.transferEventToCkbMint(event);
        ckbMintRecords.push(ckbMint);
        const tronLock = this.transferEventToTronLock(event);
        tronLockRecords.push(tronLock);
      }
      await this.db.createCkbMint(ckbMintRecords);
      await this.db.createTronLock(tronLockRecords);

      await asyncSleep(3000);
    }
  }

  private async multiSignTransferTrx(unlockRecord: TronUnlock) {
    const from = this.committee.address;
    const to = unlockRecord.recipientAddress;
    const amount = +unlockRecord.amount;
    const memo = unlockRecord.memo;
    const unsigned_tx = await this.tronWeb.transactionBuilder.sendTrx(to, amount, from, {
      permissionId: this.committee.permissionId,
    });

    const unsignedWithMemoTx = await this.tronWeb.transactionBuilder.addUpdateData(unsigned_tx, memo, 'utf8');

    let signed_tx = unsignedWithMemoTx;
    for (const key of this.committee.keys) {
      signed_tx = await this.tronWeb.trx.multiSign(signed_tx, key);
    }

    const broad_tx = await this.tronWeb.trx.broadcast(signed_tx);
    return broad_tx.txid;
  }

  private async multiSignTransferTrc10(unlockRecord: TronUnlock) {
    const from = this.committee.address;
    const to = unlockRecord.recipientAddress;
    const amount = unlockRecord.amount;
    const tokenID = unlockRecord.asset;
    const memo = unlockRecord.memo;
    const unsigned_tx = await this.tronWeb.transactionBuilder.sendToken(to, amount, tokenID, from, {
      permissionId: this.committee.permissionId,
    });

    const unsignedWithMemoTx = await this.tronWeb.transactionBuilder.addUpdateData(unsigned_tx, memo, 'utf8');

    let signed_tx = unsignedWithMemoTx;
    for (const key of this.committee.keys) {
      signed_tx = await this.tronWeb.trx.multiSign(signed_tx, key);
    }

    const broad_tx = await this.tronWeb.trx.broadcast(signed_tx);
    return broad_tx.txid;
  }

  private async multiSignTransferTrc20(unlockRecord: TronUnlock) {
    const from = this.committee.address;
    const to = unlockRecord.recipientAddress;
    const amount = unlockRecord.amount;
    const trc20ContractAddress = unlockRecord.asset;
    const memo = unlockRecord.memo;

    const options = {
      permissionId: this.committee.permissionId,
      feeLimit: ForceBridgeCore.config.tron.feeLimit,
    };
    const functionSelector = 'transfer(address,uint256)';
    const params = [
      { type: 'address', value: to },
      { type: 'uint256', value: amount },
    ];

    const unsigned_tx = await this.tronWeb.transactionBuilder.triggerSmartContract(
      trc20ContractAddress,
      functionSelector,
      options,
      params,
      from,
    );
    const unsignedWithMemoTx = await this.tronWeb.transactionBuilder.addUpdateData(
      unsigned_tx.transaction,
      memo,
      'utf8',
    );

    let signed_tx = unsignedWithMemoTx;
    for (const key of this.committee.keys) {
      signed_tx = await this.tronWeb.trx.multiSign(signed_tx, key);
    }
    const broad_tx = await this.tronWeb.trx.broadcast(signed_tx);
    return broad_tx.txid;
  }

  // watch the tron_unlock table and handle the new unlock events
  // send tx according to the data
  async watchUnlockEvents(): Promise<void> {
    while (true) {
      logger.debug('flush pending tx to confirm');
      const pendingRecords = await this.db.getTronUnlockRecords('pending');
      for (const pendingRecord of pendingRecords) {
        // todo: check tx is confirmed
        pendingRecord.status = 'success';
      }
      await this.db.saveTronUnlock(pendingRecords);

      logger.debug('get new unlock events and send tx');
      const unlockRecords = await this.db.getTronUnlockRecords('todo');
      for (const unlockRecord of unlockRecords) {
        let txid: string;
        switch (unlockRecord.assetType) {
          case 'trx':
            txid = await this.multiSignTransferTrx(unlockRecord);
            break;
          case 'trc10':
            txid = await this.multiSignTransferTrc10(unlockRecord);
            break;
          case 'trc20':
            txid = await this.multiSignTransferTrc20(unlockRecord);
            break;
        }
        unlockRecord.tronTxHash = txid;
        unlockRecord.tronTxIndex = 0;
        unlockRecord.status = 'pending';
      }
      await this.db.saveTronUnlock(unlockRecords);

      await asyncSleep(3000);
    }
  }

  start() {
    this.watchLockEvents();
    this.watchUnlockEvents();
    logger.info('tron handler started  🚀');
  }
}
