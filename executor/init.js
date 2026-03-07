/**
 * One-time script to initialize ProgramConfig.
 * Run with: node init.js
 * Requires: ADMIN_KEYPAIR_PATH - keypair for the hardcoded ADMIN (AZPZ2x9oGZkBMmLLmVmYByiUokMEj8BcJwKURsvxJkNN)
 *           EXECUTOR_KEYPAIR_PATH - platform launch wallet (receives launch_amount on withdraw_for_launch)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey, SystemProgram } = require("@solana/web3.js");
const { Program, AnchorProvider } = require("@coral-xyz/anchor");

const IDL_PATH = path.join(__dirname, "../app/src/lib/stratton-idl.json");

async function main() {
  const adminPath = process.env.ADMIN_KEYPAIR_PATH;
  if (!adminPath) {
    throw new Error("ADMIN_KEYPAIR_PATH must be set (keypair for ADMIN pubkey in lib.rs)");
  }
  const executorPath = process.env.EXECUTOR_KEYPAIR_PATH;
  if (!executorPath) {
    throw new Error("EXECUTOR_KEYPAIR_PATH must be set (executor wallet to register)");
  }

  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, "utf8")))
  );
  const executor = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(executorPath, "utf8")))
  );

  const connection = new Connection(process.env.RPC_URL || "http://127.0.0.1:8899");
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const provider = new AnchorProvider(
    connection,
    { publicKey: admin.publicKey, signTransaction: async (tx) => tx },
    { commitment: "confirmed" }
  );
  const program = new Program(idl, provider);

  const [programConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  try {
    const sig = await program.methods
      .initialize(executor.publicKey)
      .accounts({
        programConfig,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    console.log("ProgramConfig initialized:", programConfig.toBase58());
    console.log("Platform launch wallet:", executor.publicKey.toBase58());
    console.log("Tx:", sig);
  } catch (err) {
    if (err.message?.includes("already in use")) {
      console.log("ProgramConfig already initialized.");
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
