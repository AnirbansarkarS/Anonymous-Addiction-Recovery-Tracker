import {
  type ConnectedAPI,
  type Configuration,
} from "@midnight-ntwrk/dapp-connector-api";
import { type ContractAddress } from "@midnight-ntwrk/compact-runtime";
import {
  type MidnightProviders,
  type PrivateStateProvider,
  type PrivateStateId,
  type MidnightProvider,
  type WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
  type CounterPrivateState,
  Counter,
  createPrivateState,
} from "@eddalabs/counter-contract";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract, type ImpureCircuitId } from "@midnight-ntwrk/compact-js";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { toHex, fromHex } from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnight-ntwrk/ledger-v7";

// Logger (simple console wrapper)
const logger = {
  info: (msg: any, ...args: any[]) => console.log(msg, ...args),
  error: (msg: any, ...args: any[]) => console.error(msg, ...args),
  trace: (msg: any, ...args: any[]) => console.debug(msg, ...args),
  warn: (msg: any, ...args: any[]) => console.warn(msg, ...args)
};

// Types
type CounterCircuits = ImpureCircuitId<Counter.Contract<CounterPrivateState>>;
const CounterPrivateStateId = "counterPrivateState";
type CounterProviders = MidnightProviders<
  CounterCircuits,
  typeof CounterPrivateStateId,
  CounterPrivateState
>;

// Contract Address (hardcoded as requested)
const CONTRACT_ADDRESS =
  "1e68c52940d1820d3302b6b5a5badd08c70300d17d6ebd04ba468be433ae30b5";

// In-Memory Private State Provider
const inMemoryPrivateStateProvider = <
  PSI extends PrivateStateId,
  PS
>(): PrivateStateProvider<PSI, PS> => {
  const record = new Map<PSI, PS>();
  const signingKeys: Record<string, any> = {};

  return {
    set: (key: PSI, state: PS) => {
      record.set(key, state);
      return Promise.resolve();
    },
    get: (key: PSI) => Promise.resolve(record.get(key) ?? null),
    remove: (key: PSI) => {
      record.delete(key);
      return Promise.resolve();
    },
    clear: () => {
      record.clear();
      return Promise.resolve();
    },
    setSigningKey: (contractAddress: ContractAddress, signingKey: any) => {
      signingKeys[contractAddress] = signingKey;
      return Promise.resolve();
    },
    getSigningKey: (contractAddress: ContractAddress) =>
      Promise.resolve(signingKeys[contractAddress] ?? null),
    removeSigningKey: (contractAddress: ContractAddress) => {
      delete signingKeys[contractAddress];
      return Promise.resolve();
    },
    clearSigningKeys: () => {
      for (const key in signingKeys) delete signingKeys[key];
      return Promise.resolve();
    },
  };
};

// State
let walletAPI: ConnectedAPI | undefined;
let contractCounter: any;

// UI Elements
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const walletStatus = document.getElementById("wallet-status") as HTMLParagraphElement;
const walletSection = document.getElementById("wallet-section") as HTMLDivElement;
const contractSection = document.getElementById("contract-section") as HTMLDivElement;
const logDayBtn = document.getElementById("log-day-btn") as HTMLButtonElement;
const sobrietyCount = document.getElementById("sobriety-count") as HTMLSpanElement;
const actionStatus = document.getElementById("action-status") as HTMLParagraphElement;

// Helper Functions
const showStatus = (msg: string) => {
  if (actionStatus) actionStatus.textContent = msg;
};

// Initialize
window.addEventListener("load", () => {
  if (connectBtn) connectBtn.addEventListener("click", connectWallet);
  if (logDayBtn) logDayBtn.addEventListener("click", incrementCounter);
});

async function connectWallet() {
  try {
    if (!window.midnight) {
      alert("Midnight wallet not found. Please install Lace.");
      return;
    }

    const walletName = "lace"; // Assume Lace for now
    const wallet = window.midnight[walletName];
    
    if (!wallet) {
        console.log("Available wallets:", Object.keys(window.midnight));
        alert("Lace wallet not detected in window.midnight");
        return;
    }

    logger.info("Connecting to wallet...");
    if (walletStatus) {
        walletStatus.textContent = "Connecting...";
        walletStatus.classList.remove("hidden");
    }

    // Connect
    walletAPI = await wallet.connect();
    
    // Get Info
    const config = await walletAPI.getConfiguration();
    const status = await walletAPI.getConnectionStatus();
    
    if (status.status === "connected") {
        setNetworkId(status.networkId);
        if (walletSection) walletSection.classList.add("hidden"); 
        if (walletStatus) walletStatus.textContent = `Connected: ${status.networkId}`;
        
        // Show Contract Section
        if (contractSection) contractSection.classList.remove("hidden");
        
        // Initialize Contract
        if (walletAPI) {
            await initContract(walletAPI, config);
        }
    } else {
        if (walletStatus) walletStatus.textContent = "Connection failed or rejected.";
    }

  } catch (e: any) {
    console.error(e);
    if (walletStatus) walletStatus.textContent = `Error: ${e.message}`;
  }
}

async function initContract(api: ConnectedAPI, config: Configuration) {
  try {
    showStatus("Initializing contract...");
    
    // 1. Providers
    const publicDataProvider = indexerPublicDataProvider(
      config.indexerUri,
      config.indexerWsUri
    );
    
    const zkConfigProvider = new FetchZkConfigProvider<CounterCircuits>(
      window.location.origin + "/midnight/counter",
      fetch.bind(window)
    );
    
    const proofProvider = httpClientProofProvider(config.proverServerUri);
    
    const privateStateProvider = inMemoryPrivateStateProvider<
        typeof CounterPrivateStateId,
        CounterPrivateState
    >();

    const walletProvider: WalletProvider = {
      getCoinPublicKey: async () => {
        const addresses = await api.getShieldedAddresses();
        return addresses.shieldedCoinPublicKey;
      },
      getEncryptionPublicKey: async () => {
        const addresses = await api.getShieldedAddresses();
        return addresses.shieldedEncryptionPublicKey;
      },
      balanceTx: async (tx: any, _ttl: any) => {
        const serialized = toHex(tx.serialize());
        const result = await api.balanceUnsealedTransaction(serialized);
        return ledger.Transaction.deserialize(
            fromHex(result.tx)
        ) as any;
      },
    };

    const midnightProvider: MidnightProvider = {
      submitTx: async (tx: any) => {
        const serialized = toHex(tx.serialize());
        const txId = await api.submitTransaction(serialized);
        return txId;
      },
    };

    const providers: CounterProviders = {
      publicDataProvider,
      zkConfigProvider,
      proofProvider,
      privateStateProvider,
      walletProvider,
      midnightProvider,
    };

    // 2. Find Deployed Contract
    logger.info("Finding contract...");
    
    // Explicitly casting Counter.Contract to avoid strict type mismatch with CompiledContract
    const contractDef = Counter.Contract as any;

    const counterCompiledContract = CompiledContract.make('counter', contractDef).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(window.location.origin + "/midnight/counter")
    );

    const deployedContract = await findDeployedContract(providers, {
      contractAddress: CONTRACT_ADDRESS,
      compiledContract: counterCompiledContract,
      privateStateId: CounterPrivateStateId,
      initialPrivateState: createPrivateState(0),
    });

    contractCounter = deployedContract;
    showStatus("Contract connected.");

    // 3. Subscribe to state
    logger.info("Subscribing to state...");
    
    providers.publicDataProvider.contractStateObservable(
        CONTRACT_ADDRESS, 
        { type: 'all' }
    ).subscribe({
        next: (contractState) => {
            const data = contractState.data;
            if (data) {
                const ledgerState = Counter.ledger(data);
                const round = ledgerState.round;
                if (sobrietyCount) sobrietyCount.textContent = round.toString();
            }
        },
        error: (err) => {
            logger.error(err);
            showStatus("Error watching state.");
        }
    });

  } catch (e: any) {
    console.error(e);
    showStatus(`Contract Error: ${e.message}`);
  }
}

async function incrementCounter() {
  if (!contractCounter) return;
  
  try {
    showStatus("Processing... Please sign in wallet.");
    logDayBtn.disabled = true;

    const txData = await contractCounter.callTx.increment();
    
    logger.info("Transaction submitted", txData);
    showStatus("Sobriety day logged!");
    
    logDayBtn.disabled = false;

  } catch (e: any) {
    console.error(e);
    showStatus(`Error: ${e.message}`);
    logDayBtn.disabled = false;
  }
}
