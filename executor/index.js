require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { Program, AnchorProvider } = require("@coral-xyz/anchor");
const { createClient } = require("@supabase/supabase-js");
const { launchOnPumpFun } = require("./pumpfun");
const { distributeTokens } = require("./distribute");

const IDL_PATH = path.join(__dirname, "../app/src/lib/stratton-idl.json");
const POLL_INTERVAL_MS = 5_000;
const RETRY_INTERVAL_MS = 60_000;
const MAX_PUMP_FUN_RETRIES = 3;
const PUMP_FUN_ENABLED = process.env.PUMP_FUN_ENABLED === "true";

function loadKeypair() {
  // Mode VPS/production : keypair encodé en base64 dans une variable d'env
  if (process.env.EXECUTOR_KEYPAIR_BASE64) {
    const secretKey = JSON.parse(
      Buffer.from(process.env.EXECUTOR_KEYPAIR_BASE64, "base64").toString("utf8")
    );
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  }

  // Mode local : lecture depuis un fichier JSON
  const keypairPath = process.env.EXECUTOR_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error(
      "Either EXECUTOR_KEYPAIR_BASE64 (production) or EXECUTOR_KEYPAIR_PATH (local) must be set"
    );
  }
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  // auth.persistSession: false — pas de session utilisateur côté serveur
  return createClient(url, key, { auth: { persistSession: false } });
}

async function main() {
  const keypair = loadKeypair();
  const connection = new Connection(process.env.RPC_URL || "http://127.0.0.1:8899");

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const executorWallet = {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => { tx.partialSign(keypair); return tx; },
    signAllTransactions: async (txs) => txs.map((tx) => { tx.partialSign(keypair); return tx; }),
  };
  const provider = new AnchorProvider(connection, executorWallet, { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const supabase = createSupabaseClient();

  console.log(`Executor started. Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`[pump.fun] ${PUMP_FUN_ENABLED ? "Activé" : "Désactivé"}`);
  console.log(`Polling every ${POLL_INTERVAL_MS / 1000}s for Ready pools...`);

  // ─── Helper: exécute pump.fun + distribution et met à jour Supabase ──────────
  async function runPumpFunAndDistribute(poolPubkey, launchAmountLamports) {
    const tokenConnection = new Connection(process.env.PUMP_FUN_RPC_URL, "confirmed");

    // Lance le token sur pump.fun
    // Si mint_address est déjà présent (pump.fun a réussi mais distribution a échoué),
    // on saute le lancement et on retente uniquement la distribution.
    const { data: poolRow } = await supabase
      .from("pools")
      .select("mint_address")
      .eq("pubkey", poolPubkey.toBase58())
      .single();

    let mintPublicKey;
    let pumpFunUrl;

    if (poolRow?.mint_address) {
      // pump.fun a déjà réussi — on retente seulement la distribution
      mintPublicKey = new PublicKey(poolRow.mint_address);
      pumpFunUrl = `https://pump.fun/${poolRow.mint_address}`;
      console.log(`[pump.fun] Mint déjà créé (${poolRow.mint_address}), relance distribution uniquement.`);
    } else {
      const result = await launchOnPumpFun({
        poolPubkey,
        launchKeypair: keypair,
        launchAmountLamports,
        supabase,
      });
      mintPublicKey = result.mintPublicKey;
      pumpFunUrl = result.pumpUrl;
    }

    // Distribution des tokens aux contributeurs
    await distributeTokens({
      poolPubkey,
      mintPublicKey,
      launchKeypair: keypair,
      program,
      tokenConnection,
      supabase,
    });

    return pumpFunUrl;
  }

  // ─── Polling principal : pools en état Ready ──────────────────────────────────
  async function processReadyPools() {
    try {
      const accounts = await program.account.poolState.all();
      const readyPools = accounts.filter((a) => a.account.status?.ready !== undefined);

      for (const { publicKey: poolStatePubkey } of readyPools) {
        try {
          const freshPool = await program.account.poolState.fetch(poolStatePubkey);
          if (freshPool.status?.ready === undefined) continue;

          const [programConfigPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("config")],
            program.programId
          );
          const programConfigData = await program.account.programConfig.fetch(programConfigPda);
          const launchWallet = programConfigData.executorWallet;

          const [vault] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), poolStatePubkey.toBuffer()],
            program.programId
          );

          const launchAmountLamports =
            BigInt(freshPool.targetNetLamports.toString()) +
            BigInt(freshPool.bonusPoolLamports.toString());

          const sig = await program.methods
            .withdrawForLaunch()
            .accountsStrict({
              programConfig: programConfigPda,
              poolState: poolStatePubkey,
              vault,
              platformFeeWallet: freshPool.platformFeeWallet,
              launchWallet,
              caller: keypair.publicKey,
              systemProgram: new PublicKey("11111111111111111111111111111111"),
            })
            .signers([keypair])
            .rpc();

          console.log(`withdraw_for_launch OK: ${poolStatePubkey.toBase58()} -> ${sig}`);

          // Lancement pump.fun + distribution
          let pumpFunUrl = "https://pump.fun (coming soon)";

          if (PUMP_FUN_ENABLED) {
            // Marque le pool comme "en attente" immédiatement
            await supabase
              .from("pools")
              .update({ pump_fun_status: "pending", pump_fun_retry_count: 0 })
              .eq("pubkey", poolStatePubkey.toBase58());

            try {
              pumpFunUrl = await runPumpFunAndDistribute(poolStatePubkey, launchAmountLamports);

              await supabase
                .from("pools")
                .update({ pump_fun_status: "success", pump_fun_last_error: null })
                .eq("pubkey", poolStatePubkey.toBase58());
            } catch (pumpErr) {
              console.error(`[pump.fun] Échec initial pour ${poolStatePubkey.toBase58()}:`, pumpErr.message);
              await supabase
                .from("pools")
                .update({
                  pump_fun_status: "pending",
                  pump_fun_retry_count: 1,
                  pump_fun_last_error: pumpErr.message,
                })
                .eq("pubkey", poolStatePubkey.toBase58());
            }
          } else {
            console.log(`[pump.fun] Désactivé — URL placeholder conservée`);
          }

          await supabase
            .from("pools")
            .update({ pump_fun_url: pumpFunUrl })
            .eq("pubkey", poolStatePubkey.toBase58());

        } catch (err) {
          console.error(`Error processing pool ${poolStatePubkey.toBase58()}:`, err.message);
        }
      }
    } catch (err) {
      console.error("Error fetching pools:", err.message);
    }
  }

  // ─── Polling de retry : pools pump.fun en échec temporaire ───────────────────
  async function processFailedLaunches() {
    if (!PUMP_FUN_ENABLED) return;

    try {
      const { data: pendingPools, error } = await supabase
        .from("pools")
        .select("pubkey, mint_address, pump_fun_retry_count")
        .eq("pump_fun_status", "pending")
        .lt("pump_fun_retry_count", MAX_PUMP_FUN_RETRIES);

      if (error) { console.error("[retry] Supabase error:", error.message); return; }
      if (!pendingPools || pendingPools.length === 0) return;

      console.log(`[retry] ${pendingPools.length} pool(s) pump.fun à relancer...`);

      for (const { pubkey, pump_fun_retry_count } of pendingPools) {
        const poolPubkey = new PublicKey(pubkey);
        const retryNum = (pump_fun_retry_count ?? 0) + 1;

        console.log(`[retry] Pool ${pubkey} — tentative ${retryNum}/${MAX_PUMP_FUN_RETRIES}`);

        try {
          // Récupère le montant on-chain (pool déjà Launched, on lit le vault_bump / bonus)
          // Le SOL est dans le launch wallet — on passe 0n car launchOnPumpFun
          // utilisera le solde réel du wallet si mint_address est absent.
          const pumpFunUrl = await runPumpFunAndDistribute(poolPubkey, 0n);

          await supabase
            .from("pools")
            .update({
              pump_fun_status: "success",
              pump_fun_url: pumpFunUrl,
              pump_fun_last_error: null,
            })
            .eq("pubkey", pubkey);

          console.log(`[retry] ✓ Pool ${pubkey} relancée avec succès.`);
        } catch (retryErr) {
          const newCount = retryNum;
          const isFinal = newCount >= MAX_PUMP_FUN_RETRIES;

          console.error(
            `[retry] Échec tentative ${newCount}/${MAX_PUMP_FUN_RETRIES} pour ${pubkey}:`,
            retryErr.message
          );

          await supabase
            .from("pools")
            .update({
              pump_fun_status: isFinal ? "failed" : "pending",
              pump_fun_retry_count: newCount,
              pump_fun_last_error: retryErr.message,
            })
            .eq("pubkey", pubkey);

          if (isFinal) {
            console.error(
              `[retry] ⚠ Pool ${pubkey} définitivement en échec après ${MAX_PUMP_FUN_RETRIES} tentatives.` +
              ` Intervention manuelle requise.`
            );
          }
        }
      }
    } catch (err) {
      console.error("[retry] Erreur inattendue:", err.message);
    }
  }

  // ─── Démarrage des deux boucles ───────────────────────────────────────────────
  await processReadyPools();
  setInterval(processReadyPools, POLL_INTERVAL_MS);
  setInterval(processFailedLaunches, RETRY_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
