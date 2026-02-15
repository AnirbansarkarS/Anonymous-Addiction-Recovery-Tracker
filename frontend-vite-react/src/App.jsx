import { useCallback, useMemo, useState } from "react";
import * as ledger from "@midnight-ntwrk/ledger-v7";
import { Counter } from "../../addiction-contract/dist/index.js";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { fromHex, toHex } from "@midnight-ntwrk/compact-runtime";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

const CONTRACT_ADDRESS =
  "1e68c52940d1820d3302b6b5a5badd08c70300d17d6ebd04ba468be433ae30b5";
const CONFIGURED_NETWORK_ID = "undeployed"; // Set to: undeployed, preview, preprod, mainnet, or qanet.
const PRIVATE_STATE_ID = "sobrietyPrivateState";
const LACE_WALLET_KEYS = ["mnLace", "lace"];
const SUPPORTED_NETWORK_IDS = ["mainnet", "preprod", "preview", "qanet", "undeployed"];

function resolveNetworkId(networkId) {
  const normalized = (networkId ?? "").trim().toLowerCase();

  if (normalized === "deployed") {
    return "undeployed";
  }

  if (SUPPORTED_NETWORK_IDS.includes(normalized)) {
    return normalized;
  }

  return "undeployed";
}

function createInMemoryPrivateStateProvider() {
  const states = new Map();
  const signingKeys = {};

  return {
    set(key, state) {
      states.set(key, state);
      return Promise.resolve();
    },
    get(key) {
      return Promise.resolve(states.get(key) ?? null);
    },
    remove(key) {
      states.delete(key);
      return Promise.resolve();
    },
    clear() {
      states.clear();
      return Promise.resolve();
    },
    setSigningKey(contractAddress, signingKey) {
      signingKeys[contractAddress] = signingKey;
      return Promise.resolve();
    },
    getSigningKey(contractAddress) {
      return Promise.resolve(signingKeys[contractAddress] ?? null);
    },
    removeSigningKey(contractAddress) {
      delete signingKeys[contractAddress];
      return Promise.resolve();
    },
    clearSigningKeys() {
      Object.keys(signingKeys).forEach((contractAddress) => {
        delete signingKeys[contractAddress];
      });
      return Promise.resolve();
    },
  };
}

function getLaceWalletApi() {
  const walletRegistry = window.midnight ?? {};

  for (const key of LACE_WALLET_KEYS) {
    if (walletRegistry[key]) {
      return { key, initialApi: walletRegistry[key] };
    }
  }

  const fallback = Object.entries(walletRegistry).find(([, api]) => {
    return typeof api?.name === "string" && api.name.toLowerCase().includes("lace");
  });

  if (fallback) {
    return { key: fallback[0], initialApi: fallback[1] };
  }

  throw new Error("Lace wallet was not found. Please install/open Midnight Lace and refresh.");
}

function extractAnonymousAddress(shieldedAddresses) {
  return shieldedAddresses?.shieldedAddress ?? "Not available";
}

function formatError(error) {
  if (!error) {
    return "Unknown error.";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error.";
}

function createProviders({ connectedApi, serviceUriConfig, shieldedAddresses, setStatusMessage }) {
  const privateStateProvider = createInMemoryPrivateStateProvider();
  const zkConfigProvider = new FetchZkConfigProvider(
    `${window.location.origin}/midnight/counter`,
    fetch.bind(window),
  );
  const publicDataProvider = indexerPublicDataProvider(
    serviceUriConfig.indexerUri,
    serviceUriConfig.indexerWsUri,
  );
  const rawProofProvider = httpClientProofProvider(serviceUriConfig.proverServerUri, zkConfigProvider);

  const proofProvider = {
    async proveTx(tx, proveTxConfig) {
      setStatusMessage("Generating zero-knowledge proof...");
      return rawProofProvider.proveTx(tx, proveTxConfig);
    },
  };

  const walletProvider = {
    getCoinPublicKey() {
      return shieldedAddresses?.shieldedCoinPublicKey;
    },
    getEncryptionPublicKey() {
      return shieldedAddresses?.shieldedEncryptionPublicKey;
    },
    async balanceTx(tx) {
      setStatusMessage("Requesting signature from Lace wallet...");
      const serializedTx = toHex(tx.serialize());
      const balancedTx = await connectedApi.balanceUnsealedTransaction(serializedTx);

      if (!balancedTx?.tx) {
        throw new Error("Wallet did not return a balanced transaction.");
      }

      return ledger.Transaction.deserialize(
        "signature",
        "proof",
        "binding",
        fromHex(balancedTx.tx),
      );
    },
  };

  const midnightProvider = {
    async submitTx(tx) {
      setStatusMessage("Submitting transaction to Midnight...");
      await connectedApi.submitTransaction(toHex(tx.serialize()));

      const txId = tx.identifiers()[0];
      if (!txId) {
        throw new Error("Unable to resolve transaction id after submission.");
      }

      setStatusMessage("Waiting for transaction confirmation...");
      return txId;
    },
  };

  return {
    privateStateProvider,
    zkConfigProvider,
    publicDataProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  };
}

export default function App() {
  const NETWORK_ID = resolveNetworkId(CONFIGURED_NETWORK_ID);
  const compiledContract = useMemo(() => {
    return CompiledContract.make("counter", Counter.Contract).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(`${window.location.origin}/midnight/counter`),
    );
  }, []);

  const [session, setSession] = useState(null);
  const [sobrietyDays, setSobrietyDays] = useState(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const readSobrietyDaysFromProviders = useCallback(async (providers) => {
    const contractState = await providers.publicDataProvider.queryContractState(CONTRACT_ADDRESS);

    if (!contractState?.data) {
      throw new Error("Could not read contract state. Verify contract address and network.");
    }

    const currentDays = Number(Counter.ledger(contractState.data).round);
    setSobrietyDays(currentDays);
    console.log("[RecoveryTracker] Counter state read", { sobrietyDays: currentDays });
    return currentDays;
  }, []);

  const connectLaceWallet = useCallback(async () => {
    setIsConnecting(true);
    setErrorMessage("");
    setStatusMessage("Connecting to Lace wallet...");

    try {
      const { key, initialApi } = getLaceWalletApi();
      if (NETWORK_ID !== CONFIGURED_NETWORK_ID) {
        console.warn("[RecoveryTracker] Invalid configured network id. Falling back.", {
          configured: CONFIGURED_NETWORK_ID,
          using: NETWORK_ID,
        });
      }
      console.log("[RecoveryTracker] Connecting wallet", { walletKey: key, network: NETWORK_ID });

      const connectedApi = await initialApi.connect(NETWORK_ID);
      const serviceUriConfig = await connectedApi.getConfiguration();
      const connectionStatus = await connectedApi.getConnectionStatus();
      const shieldedAddresses = await connectedApi.getShieldedAddresses();

      const resolvedNetwork = connectionStatus?.networkId ?? NETWORK_ID;
      setNetworkId(resolvedNetwork);

      const providers = createProviders({
        connectedApi,
        serviceUriConfig,
        shieldedAddresses,
        setStatusMessage,
      });

      setStatusMessage("Connecting to smart contract...");

      const deployedContract = await findDeployedContract(providers, {
        contractAddress: CONTRACT_ADDRESS,
        compiledContract,
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: {},
      });

      setSession({
        connectedApi,
        providers,
        deployedContract,
        walletAddress: extractAnonymousAddress(shieldedAddresses),
        networkId: resolvedNetwork,
      });

      setStatusMessage("Reading sobriety counter from chain...");
      await readSobrietyDaysFromProviders(providers);

      setStatusMessage("Connected. Ready to log sober days.");
      console.log("[RecoveryTracker] Connected", {
        contractAddress: CONTRACT_ADDRESS,
        network: resolvedNetwork,
      });
    } catch (error) {
      console.error("[RecoveryTracker] Wallet/contract connection failed", error);
      setErrorMessage(formatError(error));
      setStatusMessage("");
    } finally {
      setIsConnecting(false);
    }
  }, [compiledContract, readSobrietyDaysFromProviders]);

  const refreshSobrietyDays = useCallback(async () => {
    if (!session?.providers) {
      setErrorMessage("Connect Lace wallet first.");
      return;
    }

    setIsRefreshing(true);
    setErrorMessage("");
    setStatusMessage("Refreshing on-chain counter...");

    try {
      await readSobrietyDaysFromProviders(session.providers);
      setStatusMessage("Counter refreshed.");
    } catch (error) {
      console.error("[RecoveryTracker] Counter refresh failed", error);
      setErrorMessage(formatError(error));
      setStatusMessage("");
    } finally {
      setIsRefreshing(false);
    }
  }, [readSobrietyDaysFromProviders, session]);

  const logSoberDay = useCallback(async () => {
    if (!session?.deployedContract || !session?.providers) {
      setErrorMessage("Connect Lace wallet first.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage("");
    setStatusMessage("Creating transaction for \"Log Sober Day\"...");

    try {
      const txData = await session.deployedContract.callTx.increment();
      console.log("[RecoveryTracker] Increment confirmed", txData?.public ?? txData);

      await readSobrietyDaysFromProviders(session.providers);
      setStatusMessage("Sober day logged and confirmed.");
    } catch (error) {
      console.error("[RecoveryTracker] Increment failed", error);
      setErrorMessage(formatError(error));
      setStatusMessage("");
    } finally {
      setIsSubmitting(false);
    }
  }, [readSobrietyDaysFromProviders, session]);

  const walletAddress = session?.walletAddress ?? "Not connected";
  const displayedDays = sobrietyDays ?? "-";

  return (
    <div className="app-shell">
      <div className="card">
        <h1>Anonymous Addiction Recovery Tracker</h1>
        <p className="subtitle">Anonymous milestone logging on Midnight blockchain</p>

        <p className="description">
          Sobriety is represented as an on-chain counter tied to your wallet identity. Each
          successful proof increments your private recovery milestone without revealing personal
          details.
        </p>

        <div className="contract-info">
          <div>
            <span className="label">Contract Address</span>
            <span className="value mono">{CONTRACT_ADDRESS}</span>
          </div>
          <div>
            <span className="label">Network</span>
            <span className="value">{NETWORK_ID} (replace later after deployment)</span>
          </div>
        </div>

        <div className="action-row">
          <button onClick={connectLaceWallet} disabled={isConnecting || isSubmitting || isRefreshing}>
            {isConnecting ? "Connecting..." : "Connect Lace Wallet"}
          </button>

          <button
            className="secondary"
            onClick={refreshSobrietyDays}
            disabled={!session || isConnecting || isSubmitting || isRefreshing}
          >
            {isRefreshing ? "Refreshing..." : "Read Counter"}
          </button>

          <button
            className="primary"
            onClick={logSoberDay}
            disabled={!session || isConnecting || isSubmitting || isRefreshing}
          >
            {isSubmitting ? "Logging..." : "Log Sober Day"}
          </button>
        </div>

        <div className="stats">
          <p>
            <span className="label">Anonymous Wallet Address</span>
            <span className="value mono">{walletAddress}</span>
          </p>
          <p className="days">Sobriety Days: {displayedDays}</p>
        </div>

        {statusMessage ? <p className="status">{statusMessage}</p> : null}
        {errorMessage ? <p className="error">{errorMessage}</p> : null}
      </div>
    </div>
  );
}
