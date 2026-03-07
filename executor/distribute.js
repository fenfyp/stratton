const {
  PublicKey,
  Connection,
  Transaction,
} = require("@solana/web3.js");
const {
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

// Nombre de contributeurs traités par transaction (limite ~10 pour rester sous le MTU)
const BATCH_SIZE = 8;

/**
 * Distribue les tokens SPL du launch wallet aux contributeurs d'une pool,
 * proportionnellement à leur contribution nette on-chain.
 *
 * @param {object}  params
 * @param {import("@solana/web3.js").PublicKey}       params.poolPubkey
 * @param {import("@solana/web3.js").PublicKey}       params.mintPublicKey
 * @param {import("@solana/web3.js").Keypair}         params.launchKeypair
 * @param {import("@coral-xyz/anchor").Program}       params.program    - Stratton program (pour ContributorState)
 * @param {import("@solana/web3.js").Connection}      params.tokenConnection - RPC où vivent les tokens (mainnet/devnet)
 * @param {import("@supabase/supabase-js").SupabaseClient} params.supabase
 */
async function distributeTokens({ poolPubkey, mintPublicKey, launchKeypair, program, tokenConnection, supabase }) {
  console.log(`[distribute] Début distribution pour pool ${poolPubkey.toBase58()}`);

  // 1. Récupère les wallets contributeurs depuis Supabase
  const { data: contributors, error: sbError } = await supabase
    .from("pool_contributors")
    .select("wallet")
    .eq("pool_pubkey", poolPubkey.toBase58());

  if (sbError) throw new Error(`Supabase pool_contributors: ${sbError.message}`);
  if (!contributors || contributors.length === 0) {
    console.log(`[distribute] Aucun contributeur trouvé pour ce pool.`);
    return;
  }

  console.log(`[distribute] ${contributors.length} contributeur(s) trouvé(s).`);

  // 2. Fetch on-chain ContributorState pour chaque wallet
  const shares = [];
  let totalNetLamports = BigInt(0);

  for (const { wallet } of contributors) {
    const walletPk = new PublicKey(wallet);
    const [contributorPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), poolPubkey.toBuffer(), walletPk.toBuffer()],
      program.programId
    );
    try {
      const state = await program.account.contributorState.fetch(contributorPda);
      const net = BigInt(state.contributedNetLamports.toString());
      if (net > 0n) {
        shares.push({ wallet, walletPk, net });
        totalNetLamports += net;
      }
    } catch {
      // ContributorState inexistant (exit total avant le launch) — ignoré
    }
  }

  if (shares.length === 0 || totalNetLamports === 0n) {
    console.log(`[distribute] Aucun contributeur actif (tous ont fait exit).`);
    return;
  }

  // 3. Récupère le solde de tokens du launch wallet
  const launchAta = getAssociatedTokenAddressSync(mintPublicKey, launchKeypair.publicKey);
  const launchAtaAccount = await getAccount(tokenConnection, launchAta);
  const totalTokens = BigInt(launchAtaAccount.amount.toString());

  if (totalTokens === 0n) {
    console.log(`[distribute] Solde de tokens nul sur le launch wallet — rien à distribuer.`);
    return;
  }

  console.log(
    `[distribute] ${totalTokens} tokens à distribuer entre ${shares.length} contributeur(s) ` +
    `(total net: ${totalNetLamports} lamports).`
  );

  // 4. Calcule les parts et prépare les instructions en batches
  let distributed = 0n;
  const batches = [];

  for (let i = 0; i < shares.length; i += BATCH_SIZE) {
    batches.push(shares.slice(i, i + BATCH_SIZE));
  }

  for (const [batchIdx, batch] of batches.entries()) {
    const tx = new Transaction();

    for (const { walletPk, net } of batch) {
      // Calcul proportionnel (arrondi inférieur pour éviter de dépasser le solde)
      const tokensForContributor = (totalTokens * net) / totalNetLamports;
      if (tokensForContributor === 0n) continue;

      const recipientAta = getAssociatedTokenAddressSync(mintPublicKey, walletPk);

      // Crée l'ATA du destinataire si inexistant (idempotent — ne fait rien si déjà créé)
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          launchKeypair.publicKey, // payer
          recipientAta,
          walletPk,
          mintPublicKey
        )
      );

      // Transfert de tokens
      tx.add(
        createTransferInstruction(
          launchAta,        // source
          recipientAta,     // destination
          launchKeypair.publicKey, // owner de la source
          tokensForContributor,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      distributed += tokensForContributor;
    }

    if (tx.instructions.length === 0) continue;

    const { blockhash } = await tokenConnection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = launchKeypair.publicKey;
    tx.sign(launchKeypair);

    const sig = await tokenConnection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await tokenConnection.confirmTransaction(sig, "confirmed");
    console.log(`[distribute] Batch ${batchIdx + 1}/${batches.length} OK → ${sig}`);
  }

  console.log(`[distribute] ✓ ${distributed} tokens distribués au total.`);
}

module.exports = { distributeTokens };
