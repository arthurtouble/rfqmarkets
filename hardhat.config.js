import { configVariable, defineConfig } from "hardhat/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";

export default defineConfig({
  plugins: [hardhatEthers],
  networks: {
    hardhatOp: { type: "edr-simulated", chainType: "op" },
    baseSepolia: {
      type:"http", chainType:"op", chainId:84_532,
      url:configVariable("RFQ_BASE_SEPOLIA_RPC_URL"),
      accounts:[configVariable("RFQ_DEPLOYER_KEY")],
    },
  },
});
