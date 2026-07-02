// =============================================================================
//  azguard.ts - external-wallet adapter (Azguard) over its inpage RPC.
// =============================================================================
//  Talks to the Azguard extension through @azguardwallet/client, which is
//  dependency-free and VERSION-NEUTRAL: every operation is declarative JSON
//  (plain strings + unencoded args), so no second aztec.js ever enters the
//  bundle and the dApp's own protocol version stays out of the wallet path.
//  The wallet holds the keys, builds + proves the txs, and pays its own fees.
//
//  Mainnet-readiness note: the extension ships against the aztec 4.x line
//  today while this deployment runs 5.0-nightly (AZUP-2). The session /
//  connect / operation plumbing here is version-independent; transaction
//  execution against THIS registry lights up the moment Azguard ships a
//  build for the same protocol line (AZUP-2 reaches mainnet this month).
//  azguardChainSupported() surfaces that gate to the UI honestly.
// =============================================================================
import type { AzguardClient as AzguardClientT } from '@azguardwallet/client';
import type { CaipAccount, CaipChain, Operation, OperationResult } from '@azguardwallet/types';

const LS_SESSION = 'azns.azguard.session'; // remember that the user chose Azguard

// The chain we WANT: our node's L1 chain id (CAIP-2 "aztec:<l1ChainId>").
// The wallet's supported list is discovered at connect time.
const WANTED_CHAIN: CaipChain = `aztec:${11155111}`;

type AzState = {
  client: AzguardClientT;
  account: CaipAccount;        // "aztec:<chain>:<address>"
  address: string;             // bare 0x… aztec address
  chain: CaipChain;            // chain of the approved account
  chainSupported: boolean;     // wallet approved the chain this dApp runs on
  walletVersion: string;
};
let az: AzState | null = null;
let azConnecting: Promise<AzState> | null = null;

async function clientLib() {
  const { AzguardClient } = await import('@azguardwallet/client');
  return AzguardClient;
}

/** True when the Azguard extension is present in this browser. */
export async function azguardAvailable(timeoutMs = 1500): Promise<boolean> {
  try { return await (await clientLib()).isAzguardInstalled(timeoutMs); }
  catch { return false; }
}

/** The active Azguard session, if any. */
export function azguardState(): { address: string; chain: string; chainSupported: boolean; walletVersion: string } | null {
  return az ? { address: az.address, chain: az.chain, chainSupported: az.chainSupported, walletVersion: az.walletVersion } : null;
}
export function azguardWantsReconnect(): boolean {
  return (globalThis.localStorage?.getItem(LS_SESSION) ?? '') === '1';
}

/** Connect (or resume) an Azguard session and return its first account. */
export async function azguardConnect(): Promise<{ address: string; chain: string; chainSupported: boolean }> {
  if (az) return { address: az.address, chain: az.chain, chainSupported: az.chainSupported };
  if (azConnecting) { const s = await azConnecting; return { address: s.address, chain: s.chain, chainSupported: s.chainSupported }; }
  azConnecting = (async () => {
    const AzguardClient = await clientLib();
    const client = await AzguardClient.create();
    const info = await client.getWalletInfo().catch(() => null);
    const walletVersion = (info as any)?.version ?? 'unknown';
    if (!client.connected) {
      // Ask for our chain as OPTIONAL alongside a required baseline, so users
      // on wallet builds that don't know this chain can still connect and see
      // the honest "wallet doesn't support this network yet" state in the UI.
      const methods = [
        'send_transaction', 'simulate_views', 'execute_utility',
        'register_contract', 'register_sender', 'call', 'add_private_authwit',
      ] as any[];
      await client.connect(
        {
          name: 'truProtocol',
          description: 'Private .tru names on Aztec - registration, multichain records, private payments.',
          url: globalThis.location?.origin,
        },
        [{ methods }],                                   // required: the ops we use
        [{ chains: [WANTED_CHAIN], methods }],           // optional: our chain
      );
    }
    const accounts = client.accounts;
    if (!accounts.length) throw new Error('Azguard connected but approved no accounts.');
    const account = accounts[0];
    const [ns, chainNum, address] = account.split(':');
    const chain = `${ns}:${chainNum}` as CaipChain;
    const chainSupported = accounts.some((a) => a.startsWith(`${WANTED_CHAIN}:`));
    client.onDisconnected.addHandler(() => { az = null; globalThis.localStorage?.removeItem(LS_SESSION); });
    az = { client, account, address, chain, chainSupported, walletVersion };
    globalThis.localStorage?.setItem(LS_SESSION, '1');
    return az;
  })();
  try { const s = await azConnecting; return { address: s.address, chain: s.chain, chainSupported: s.chainSupported }; }
  finally { azConnecting = null; }
}

export async function azguardDisconnect(): Promise<void> {
  globalThis.localStorage?.removeItem(LS_SESSION);
  const cur = az; az = null;
  try { await cur?.client.disconnect(); } catch { /* session already gone */ }
}

// ---- operation helpers ---------------------------------------------------------
function need(): AzState {
  if (!az) throw new Error('Azguard is not connected.');
  return az;
}
function unwrap<T>(r: OperationResult, what: string): T {
  const res: any = r;
  if (res?.status === 'ok') return res.result as T;
  if (res?.status === 'skipped') throw new Error(`${what}: skipped (a previous operation in the batch failed)`);
  throw new Error(`${what}: ${res?.error ?? 'unknown wallet error'}`);
}
async function exec(ops: Operation[]): Promise<OperationResult[]> {
  return need().client.execute(ops);
}

/** Batch of public view calls, decoded by the wallet with the contract ABI. */
export async function azSimulateViews(calls: { contract: string; method: string; args: any[] }[]): Promise<any[]> {
  const s = need();
  const [r] = await exec([{ kind: 'simulate_views', account: s.account, calls: calls.map((c) => ({ kind: 'call' as const, ...c })) }]);
  return (unwrap<{ decoded: any[] }>(r, 'simulate_views')).decoded;
}

/** One utility (unconstrained) call - e.g. balance_of_private. */
export async function azUtility(contract: string, method: string, args: any[]): Promise<any> {
  const s = need();
  const [r] = await exec([{ kind: 'execute_utility', account: s.account, contract, method, args }]);
  return unwrap<any>(r, `${method}()`);
}

/** Send ONE transaction built from the given actions (calls + authwits).
 *  The wallet encodes, proves, pays fees its own way, and returns the tx hash. */
export async function azSendTx(actions: any[]): Promise<string> {
  const s = need();
  const [r] = await exec([{ kind: 'send_transaction', account: s.account, actions }]);
  return unwrap<string>(r, 'send_transaction');
}

/** Register a contract in the WALLET's PXE (address-only lets the wallet fetch
 *  the instance; pass the artifact when the wallet can't discover it). */
export async function azRegisterContract(address: string, artifact?: unknown): Promise<void> {
  const s = need();
  const [r] = await exec([{ kind: 'register_contract', chain: s.chain, address, artifact }]);
  unwrap<void>(r, 'register_contract');
}

/** Register a discovered payer in the wallet's PXE so its notes appear -
 *  the beacon-discovery hook for external-wallet users. */
export async function azRegisterSender(address: string): Promise<void> {
  const s = need();
  const [r] = await exec([{ kind: 'register_sender', chain: s.chain, address }]);
  unwrap<void>(r, 'register_sender');
}

// Console hook so the Azguard flow is driveable/inspectable from devtools
// (the preview environment has no extension, so this is how availability +
// graceful degradation get verified without a real wallet installed).
try {
  if (typeof window !== 'undefined') {
    (window as any).azguardDbg = {
      azguardAvailable, azguardConnect, azguardDisconnect, azguardState, azguardWantsReconnect,
      azSimulateViews, azUtility, azSendTx, azRegisterContract, azRegisterSender,
    };
  }
} catch { /* no window */ }
