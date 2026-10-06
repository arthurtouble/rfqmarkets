import { configVariable, defineConfig } from "hardhat/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";

export default defineConfig({
  plugins: [hardhatEthers],
  networks: {
    hardhatOp: { type: "edr-simulated", chainType: "op" },
    // Local chain that reports Base mainnet's chain ID; used only by the mainnet deployment rehearsal.
    hardhatBaseRehearsal: { type: "edr-simulated", chainType: "op", chainId: 8_453 },
    baseSepolia: {
      type:"http", chainType:"op", chainId:84_532,
      url:configVariable("RFQ_BASE_SEPOLIA_RPC_URL"),
      accounts:[configVariable("RFQ_DEPLOYER_KEY")],
    },
    base: {
      type:"http", chainType:"op", chainId:8_453,
      url:configVariable("RFQ_BASE_MAINNET_RPC_URL"),
      accounts:[configVariable("RFQ_MAINNET_DEPLOYER_KEY")],
    },
  },
});
