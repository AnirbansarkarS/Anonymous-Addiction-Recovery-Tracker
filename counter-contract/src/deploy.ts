import { deployContract } from "./utils/deploy-helper.js";

async function main() {
  console.log("Deploying Anonymous Addiction Recovery Tracker contract...");

  const threshold = 30; // Example: 30 days sobriety requirement

  const contract = await deployContract({
    contractName: "addiction",
    constructorArgs: [threshold],
  });

  console.log("Contract deployed successfully!");
  console.log("Contract Address:", contract.address);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
