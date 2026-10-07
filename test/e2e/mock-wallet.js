// A browser-extension wallet for end-to-end tests. Announces itself over
// EIP-6963 like Rabby or MetaMask, keeps its connection and chain in
// localStorage so reloads behave like a real extension, and forwards signing
// and transactions to the local Hardhat node, whose accounts are unlocked.
// Tests drive it through window.__wallet (reject, hang, failSwitch, chainId, address).
// Set window.__mockWalletConfig = { announce: false } first for a legacy
// wallet that only sets window.ethereum.
(() => {
  const cfg = window.__mockWalletConfig || {};
  const RPC = cfg.rpc || "http://127.0.0.1:8545";
  const HOME_CHAIN = cfg.chainId || "0x7a69";
  const KEY = "mock-wallet-state";
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  // Hardhat account #9 by default: unlocked, funded with ETH, never used by the local stack.
  const state = Object.assign({ connected: false, address: (cfg.address || "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720").toLowerCase(), chainId: HOME_CHAIN, reject: false, failSwitch: false }, read());
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const listeners = {};
  const emit = (event, value) => (listeners[event] || []).forEach(fn => { try { fn(value); } catch (e) { console.error(e); } });
  const rejected = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
  const rpc = async (method, params) => {
    const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
    const json = await response.json();
    if (json.error) throw Object.assign(new Error(json.error.message), { code: json.error.code, data: json.error.data });
    return json.result;
  };
  const provider = {
    isMetaMask: false, isMockWallet: true,
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_requestAccounts":
          if (state.hang) return new Promise(() => {}); // a wallet window closed without an answer
          if (state.reject) throw rejected();
          state.connected = true; save(); emit("accountsChanged", [state.address]); return [state.address];
        case "eth_accounts": return state.connected ? [state.address] : [];
        case "eth_chainId": return state.chainId;
        case "net_version": return String(parseInt(state.chainId, 16));
        case "wallet_switchEthereumChain":
          if (state.reject || state.failSwitch) throw rejected();
          state.chainId = params[0].chainId; save(); emit("chainChanged", state.chainId); return null;
        case "wallet_addEthereumChain": return null;
        case "wallet_requestPermissions":
          if (state.hang) return new Promise(() => {});
          if (state.reject) throw rejected();
          state.connected = true; save(); return [{ parentCapability: "eth_accounts" }];
        case "wallet_getPermissions": return state.connected ? [{ parentCapability: "eth_accounts" }] : [];
        case "wallet_revokePermissions": state.connected = false; save(); emit("accountsChanged", []); return null;
        case "eth_signTypedData_v4": case "personal_sign": case "eth_sendTransaction":
          if (state.reject) throw rejected();
          if (state.chainId !== HOME_CHAIN) throw Object.assign(new Error("wrong chain"), { code: 4901 });
          return rpc(method, params);
        default: return rpc(method, params);
      }
    },
    on(event, fn) { (listeners[event] ||= []).push(fn); return provider; },
    removeListener(event, fn) { listeners[event] = (listeners[event] || []).filter(x => x !== fn); return provider; },
  };
  window.__wallet = {
    state,
    set(patch) {
      Object.assign(state, patch); save();
      if ("chainId" in patch) emit("chainChanged", state.chainId);
      if ("address" in patch && state.connected) emit("accountsChanged", [state.address]);
    },
  };
  window.ethereum = provider;
  const info = { uuid: "5c1b8f0e-7a52-4b3e-9a3c-000000000001", name: "Mock Wallet", rdns: "dev.rfq.mockwallet",
    icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#f80"/></svg>') };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  if (cfg.announce === false) return;
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
