/* eslint-disable flowtype/no-weak-types */
/* eslint-disable max-classes-per-file */
/* eslint-disable class-methods-use-this */

import _sodium from 'libsodium-wrappers-sumo';
import AppState, { ConnectedCompanionApp } from './components/AppState';
import Utils from './utils/utils';

// Wormhole code is sha256(sha256(secret_key))
function getWormholeCode(keyHex: string, sodium: any): string {
  const key = sodium.from_hex(keyHex);

  const pass1 = sodium.crypto_hash_sha256(key);
  const pass2 = sodium.to_hex(sodium.crypto_hash_sha256(pass1));

  return pass2;
}

// A class that connects to wormhole given a secret key
class WormholeClient {
  keyHex: string;

  wormholeCode: string;

  sodium: any;

  wss: WebSocket = null;

  listner: CompanionAppListener = null;

  keepAliveTimerID: TimerID = null;

  constructor(keyHex: string, sodium: any, listner: CompanionAppListener) {
    this.keyHex = keyHex;
    this.sodium = sodium;
    this.listner = listner;

    this.wormholeCode = getWormholeCode(keyHex, this.sodium);
    this.connect();
  }

  connect() {
    this.wss = new WebSocket('wss://wormhole.zecqtwallet.com:443');

    this.wss.onopen = () => {
      // On open, register ourself
      const reg = { register: getWormholeCode(this.keyHex, this.sodium) };

      // No encryption for the register call
      this.wss.send(JSON.stringify(reg));

      // Now, do a ping every 4 minutes to keep the connection alive.
      this.keepAliveTimerID = setInterval(() => {
        const ping = { ping: 'ping' };
        this.wss.send(JSON.stringify(ping));
      }, 4 * 60 * 1000);
    };

    this.wss.onmessage = (event) => {
      this.listner.processIncoming(event.data, this.keyHex, this.wss);
    };

    this.wss.onclose = (event) => {
      console.log('Socket closed for ', this.keyHex, event.code, event.reason);
    };

    this.wss.onerror = (err) => {
      console.log('ws error', err.message);
    };
  }

  getKeyHex(): string {
    return this.keyHex;
  }

  close() {
    if (this.keepAliveTimerID) {
      clearInterval(this.keepAliveTimerID);
    }

    // Close the websocket.
    if (this.wss) {
      this.wss.close();
    }
  }
}

// The singleton Companion App listener, that can spawn a wormhole server
// or (multiple) wormhole clients
export default class CompanionAppListener {
  sodium = null;

  fnGetState: () => AppState = null;

  fnSendTransaction: ([]) => string = null;

  fnUpdateConnectedClient: (string, number) => void = null;

  permWormholeClient: WormholeClient = null;

  tmpWormholeClient: WormholeClient = null;

  constructor(
    fnGetSate: () => AppState,
    fnSendTransaction: ([]) => string,
    fnUpdateConnectedClient: (string, number) => void
  ) {
    this.fnGetState = fnGetSate;
    this.fnSendTransaction = fnSendTransaction;
    this.fnUpdateConnectedClient = fnUpdateConnectedClient;
  }

  async setUp() {
    await _sodium.ready;
    this.sodium = _sodium;

    // Create a new wormhole listner
    const permKeyHex = this.getEncKey();
    if (permKeyHex) {
      this.permWormholeClient = new WormholeClient(permKeyHex, this.sodium, this);
    }

    // At startup, set the last client name/time by loading it
    const localStorage = window.localStorage;
    const name = localStorage.getItem('companion/name');
    const lastSeen = localStorage.getItem('companion/lastseen');

    if (name && lastSeen) {
      const o = new ConnectedCompanionApp();
      o.name = name;
      o.lastSeen = lastSeen;

      this.fnUpdateConnectedClient(o);
    }
  }

  createTmpClient(keyHex: string) {
    if (this.tmpWormholeClient) {
      this.tmpWormholeClient.close();
    }

    this.tmpWormholeClient = new WormholeClient(keyHex, this.sodium, this);
  }

  closeTmpClient() {
    if (this.tmpWormholeClient) {
      this.tmpWormholeClient.close();

      this.tmpWormholeClient = null;
    }
  }

  replacePermClientWithTmp() {
    if (this.permWormholeClient) {
      this.permWormholeClient.close();
    }

    // Replace the stored code with the new one
    this.permWormholeClient = this.tmpWormholeClient;
    this.tmpWormholeClient = null;
    this.setEncKey(this.permWormholeClient.getKeyHex());

    // Reset local nonce
    const localStorage = window.localStorage;
    localStorage.removeItem('companion/localnonce');
  }

  async processIncoming(data: string, keyHex: string, ws: Websocket) {
    const dataJson = JSON.parse(data);

    // If the wormhole sends some messages, we ignore them
    if ('error' in dataJson) {
      console.log('Incoming data contains an error message', data);
      return;
    }

    // If the message is a ping, just ignore it
    if ('ping' in dataJson) {
      return;
    }

    // Then, check if the message is encrpted
    if (!('nonce' in dataJson)) {
      const err = { error: 'Encryption error', to: getWormholeCode(keyHex, this.sodium) };
      ws.send(JSON.stringify(err));

      return;
    }

    let cmd;

    // If decryption passes and this is a tmp wormhole client, then set it as the permanant client
    if (this.tmpWormholeClient && keyHex === this.tmpWormholeClient.getKeyHex()) {
      const { decrypted, nonce } = this.decryptIncoming(data, keyHex, false);
      if (!decrypted) {
        console.log('Decryption failed');

        const err = { error: 'Encryption error', to: getWormholeCode(keyHex, this.sodium) };
        ws.send(JSON.stringify(err));
        return;
      }
      cmd = JSON.parse(decrypted);

      // Replace the permanant client
      this.replacePermClientWithTmp();

      this.updateRemoteNonce(nonce);
    } else {
      const { decrypted, nonce } = this.decryptIncoming(data, keyHex, true);
      if (!decrypted) {
        const err = { error: 'Encryption error', to: getWormholeCode(keyHex, this.sodium) };
        ws.send(JSON.stringify(err));

        console.log('Decryption failed');
        return;
      }

      cmd = JSON.parse(decrypted);

      this.updateRemoteNonce(nonce);
    }

    if (cmd.command === 'getInfo') {
      const response = this.doGetInfo(cmd);
      ws.send(this.encryptOutgoing(response, keyHex));
    } else if (cmd.command === 'getTransactions') {
      const response = this.doGetTransactions();
      ws.send(this.encryptOutgoing(response, keyHex));
    } else if (cmd.command === 'sendTx') {
      const response = await this.doSendTransaction(cmd, ws);
      ws.send(this.encryptOutgoing(response, keyHex));
    }
  }

  // Generate a new secret key
  genNewKeyHex(): string {
    const keyHex = this.sodium.to_hex(this.sodium.crypto_secretbox_keygen());

    return keyHex;
  }

  getEncKey(): string {
    // Get the nonce. Increment and store the nonce for next use
    const localStorage = window.localStorage;
    const keyHex = localStorage.getItem('companion/key');

    return keyHex;
  }

  setEncKey(keyHex: string) {
    // Get the nonce. Increment and store the nonce for next use
    const localStorage = window.localStorage;
    localStorage.setItem('companion/key', keyHex);
  }

  saveLastClientName(name: string) {
    // Save the last client name
    const localStorage = window.localStorage;
    localStorage.setItem('companion/name', name);

    if (name) {
      const now = Date.now();
      localStorage.setItem('companion/lastseen', now);

      const o = new ConnectedCompanionApp();
      o.name = name;
      o.lastSeen = now;

      this.fnUpdateConnectedClient(o);
    } else {
      this.fnUpdateConnectedClient(null);
    }
  }

  disconnectLastClient() {
    // Remove the permanant connection
    if (this.permWormholeClient) {
      this.permWormholeClient.close();
    }

    this.saveLastClientName(null);
    this.setEncKey(null);
  }

  getRemoteNonce(): string {
    const localStorage = window.localStorage;
    const nonceHex = localStorage.getItem('companion/remotenonce');

    return nonceHex;
  }

  updateRemoteNonce(nonce: string) {
    if (nonce) {
      const localStorage = window.localStorage;
      localStorage.setItem('companion/remotenonce', nonce);
    }
  }

  getLocalNonce(): string {
    // Get the nonce. Increment and store the nonce for next use
    const localStorage = window.localStorage;
    let nonceHex = localStorage.getItem('companion/localnonce');
    if (!nonceHex) {
      nonceHex = `01${'00'.repeat(this.sodium.crypto_secretbox_NONCEBYTES - 1)}`;
    }

    // Increment nonce
    const newNonce = this.sodium.from_hex(nonceHex);

    this.sodium.increment(newNonce);
    this.sodium.increment(newNonce);

    localStorage.setItem('companion/localnonce', this.sodium.to_hex(newNonce));

    return nonceHex;
  }

  encryptOutgoing(str: string, keyHex: string): string {
    if (!keyHex) {
      console.log('No secret key');
      throw Error('No Secret Key');
    }

    const nonceHex = this.getLocalNonce();

    const nonce = this.sodium.from_hex(nonceHex);
    const key = this.sodium.from_hex(keyHex);

    const encrypted = this.sodium.crypto_secretbox_easy(str, nonce, key);
    const encryptedHex = this.sodium.to_hex(encrypted);

    const resp = {
      nonce: this.sodium.to_hex(nonce),
      payload: encryptedHex,
      to: getWormholeCode(keyHex, this.sodium)
    };

    return JSON.stringify(resp);
  }

  decryptIncoming(msg: string, keyHex: string, checkNonce: boolean): any {
    const msgJson = JSON.parse(msg);
    // console.log('trying to decrypt', msgJson);

    if (!keyHex) {
      console.log('No secret key');
      throw Error('No Secret Key');
    }

    const key = this.sodium.from_hex(keyHex);
    const nonce = this.sodium.from_hex(msgJson.nonce);

    if (checkNonce) {
      const prevNonce = this.sodium.from_hex(this.getRemoteNonce());
      if (prevNonce && this.sodium.compare(prevNonce, nonce) >= 0) {
        return { decrypted: null };
      }
    }

    const cipherText = this.sodium.from_hex(msgJson.payload);

    const decrypted = this.sodium.to_string(this.sodium.crypto_secretbox_open_easy(cipherText, nonce, key));

    return { decrypted, nonce: msgJson.nonce };
  }

  doGetInfo(cmd: any): string {
    const appState = this.fnGetState();

    if (cmd && cmd.name) {
      this.saveLastClientName(cmd.name);
    }

    const saplingAddress = appState.addresses.find(a => Utils.isSapling(a));
    const tAddress = appState.addresses.find(a => Utils.isTransparent(a));
    const balance = parseFloat(appState.totalBalance.total);
    const maxspendable = parseFloat(appState.totalBalance.total);
    const maxzspendable = parseFloat(appState.totalBalance.private);
    const tokenName = appState.info.currencyName;
    const zecprice = parseFloat(appState.info.zecPrice);

    const resp = {
      version: 1.0,
      command: 'getInfo',
      saplingAddress,
      tAddress,
      balance,
      maxspendable,
      maxzspendable,
      tokenName,
      zecprice,
      serverversion: '0.9.2'
    };

    return JSON.stringify(resp);
  }

  doGetTransactions(): string {
    const appState = this.fnGetState();

    let txlist = [];
    if (appState.transactions) {
      // Get only the last 20 txns
      txlist = appState.transactions.slice(0, 20).map(t => {
        let memo = t.detailedTxns && t.detailedTxns.length > 0 ? t.detailedTxns[0].memo : '';
        if (memo) {
          memo = memo.trimRight();
        } else {
          memo = '';
        }

        const txResp = {
          type: t.type,
          datetime: t.time,
          amount: t.amount.toFixed(8),
          txid: t.txid,
          address: t.address,
          memo,
          confirmations: t.confirmations
        };

        return txResp;
      });
    }

    const resp = {
      version: 1.0,
      command: 'getTransactions',
      transactions: txlist
    };

    return JSON.stringify(resp);
  }

  async doSendTransaction(cmd: any, ws: WebSocket): string {
    // "command":"sendTx","tx":{"amount":"0.00019927","to":"zs1pzr7ee53jwa3h3yvzdjf7meruujq84w5rsr5kuvye9qg552kdyz5cs5ywy5hxkxcfvy9wln94p6","memo":""}}
    const inpTx = cmd.tx;
    const appState = this.fnGetState();

    // eslint-disable-next-line radix
    let sendingAmount = parseFloat(inpTx.amount);
    const buildError = (reason: string): string => {
      const resp = {
        errorCode: -1,
        errorMessage: `Couldn't send Tx:${reason}`
      };

      // console.log('sendtx error', resp);
      return JSON.stringify(resp);
    };

    // First, find an address that can send the correct amount.
    const fromAddress = appState.addressesWithBalance.find(ab => ab.balance > sendingAmount);
    if (!fromAddress) {
      return buildError(`No address with sufficient balance to send ${sendingAmount}`);
    }

    const memo = !inpTx.memo || inpTx.memo.trim() === '' ? null : inpTx.memo;

    // The lightclient expects zats (and not ZEC)
    sendingAmount = parseInt(sendingAmount * 10 ** 8, 10);

    // Build a sendJSON object
    const sendJSON = [];
    if (memo) {
      sendJSON.push({ address: inpTx.to, amount: sendingAmount, memo });
    } else {
      sendJSON.push({ address: inpTx.to, amount: sendingAmount });
    }

    console.log('sendjson is', sendJSON);

    let resp;

    try {
      const txid = await this.fnSendTransaction(sendJSON);

      // After the transaction is submitted, we return an intermediate success.
      resp = {
        version: 1.0,
        command: 'sendTx',
        result: 'success'
      };
      ws.send(this.encryptOutgoing(JSON.stringify(resp)));

      // And then another one when the Tx was submitted successfully. For lightclient, this is the same,
      // so we end up sending 2 responses back to back
      resp = {
        version: 1.0,
        command: 'sendTxSubmitted',
        txid
      };
    } catch (err) {
      resp = {
        version: 1.0,
        command: 'sendTxFailed',
        err
      };
    }

    return JSON.stringify(resp);
  }
}
