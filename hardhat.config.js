import { defineConfig } from "hardhat/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";

export default defineConfig({
  plugins: [hardhatEthers],
  networks: {
    hardhatOp: { type: "edr-simulated", chainType: "op" },
  },
});

