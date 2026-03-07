const { Keypair, Connection, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const { AnchorProvider } = require("@coral-xyz/anchor");
const NodeWallet = require("@coral-xyz/anchor/dist/cjs/nodewallet").default;
const { PumpFunSDK } = require("pumpdotfun-sdk");

const SLIPPAGE_BASIS_POINTS = 500n;
// Réserve pour les frais de transaction pump.fun (~0.01 SOL)
const FEE_RESERVE_LAMPORTS = BigInt(Math.floor(0.01 * LAMPORTS_PER_SOL));

/**
 * Lance un token sur pump.fun en utilisant le SOL du launch wallet.
 *
 * @param {object} params
 * @param {import("@solana/web3.js").PublicKey} params.poolPubkey
 * @param {import("@solana/web3.js").Keypair}  params.launchKeypair  - wallet qui a reçu le SOL
 * @param {bigint}                             params.launchAmountLamports - SOL reçu depuis withdraw_for_launch
 * @param {import("@supabase/supabase-js").SupabaseClient} params.supabase
 * @returns {Promise<{pumpUrl: string, mintPublicKey: import("@solana/web3.js").PublicKey}>}
 */
async function launchOnPumpFun({ poolPubkey, launchKeypair, launchAmountLamports, supabase }) {
  const rpcUrl = process.env.PUMP_FUN_RPC_URL;
  if (!rpcUrl) throw new Error("PUMP_FUN_RPC_URL must be set");

  // Récupère les métadonnées du pool depuis Supabase
  const { data: poolData, error: sbError } = await supabase
    .from("pools")
    .select("name, ticker, description, image_url")
    .eq("pubkey", poolPubkey.toBase58())
    .single();

  if (sbError || !poolData) {
    throw new Error(`Supabase: pool introuvable — ${sbError?.message}`);
  }

  const { name, ticker, description, image_url } = poolData;

  if (!image_url) throw new Error("image_url manquant dans Supabase pour ce pool");

  // Télécharge l'image et la convertit en Blob
  const imgResponse = await fetch(image_url);
  if (!imgResponse.ok) {
    throw new Error(`Échec téléchargement image (HTTP ${imgResponse.status}): ${image_url}`);
  }
  const imageBlob = await imgResponse.blob();

  // Calcule le montant SOL à utiliser pour l'achat initial
  const buyAmountLamports = launchAmountLamports - FEE_RESERVE_LAMPORTS;
  if (buyAmountLamports <= 0n) {
    throw new Error(
      `SOL insuffisant pour pump.fun: ${launchAmountLamports} lamports reçus, ` +
      `minimum requis: ${FEE_RESERVE_LAMPORTS} lamports`
    );
  }

  // Initialise le SDK pump.fun avec le RPC mainnet/devnet
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new NodeWallet(launchKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const sdk = new PumpFunSDK(provider);

  // Génère un nouveau keypair pour le mint du token
  const mint = Keypair.generate();

  console.log(
    `[pump.fun] Lancement de "${name}" ($${ticker}) ` +
    `avec ${Number(buyAmountLamports) / LAMPORTS_PER_SOL} SOL...`
  );

  const result = await sdk.createAndBuy(
    launchKeypair,
    mint,
    { name, symbol: ticker, description, file: imageBlob },
    buyAmountLamports,
    SLIPPAGE_BASIS_POINTS,
    { unitLimit: 250000, unitPrice: 250000 }
  );

  if (!result.success) {
    throw new Error(`pump.fun createAndBuy a échoué pour le pool ${poolPubkey.toBase58()}`);
  }

  const mintPublicKey = mint.publicKey;
  const mintAddress = mintPublicKey.toBase58();
  const pumpUrl = `https://pump.fun/${mintAddress}`;
  console.log(`[pump.fun] Token créé: ${pumpUrl}`);

  // Stocke l'adresse du mint dans Supabase pour la distribution future
  const { error: mintError } = await supabase
    .from("pools")
    .update({ mint_address: mintAddress })
    .eq("pubkey", poolPubkey.toBase58());

  if (mintError) {
    console.error(`[pump.fun] Erreur stockage mint_address:`, mintError.message);
  } else {
    console.log(`[pump.fun] mint_address enregistré: ${mintAddress}`);
  }

  return { pumpUrl, mintPublicKey };
}

module.exports = { launchOnPumpFun };
