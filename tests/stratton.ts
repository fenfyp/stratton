import * as anchor from "@coral-xyz/anchor";
import { Program, Idl } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

// Load IDL
const idlPath = path.join(__dirname, "../target/idl/stratton.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
const PROGRAM_ID = new PublicKey(idl.address);

// Helper to get balance
async function getBalance(connection: anchor.web3.Connection, pubkey: PublicKey): Promise<number> {
  return (await connection.getAccountInfo(pubkey))?.lamports ?? 0;
}

// Helper to log balances
async function logBalances(
  ctx: string,
  connection: anchor.web3.Connection,
  accounts: { name: string; pubkey: PublicKey }[]
) {
  console.log(`\n--- Balances: ${ctx} ---`);
  for (const { name, pubkey } of accounts) {
    const bal = await getBalance(connection, pubkey);
    console.log(`  ${name}: ${bal} lamports (${(bal / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
  }
}

describe("stratton", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  const program = new Program(idl, provider);
  const poolStateAccount = (program.account as any).poolState;
  const contributorStateAccount = (program.account as any).contributorState;

  const creator = Keypair.generate();
  const platformFeeWallet = Keypair.generate();
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  let poolStatePda: PublicKey;
  let vaultPda: PublicKey;
  let contributor1Pda: PublicKey;
  let contributor2Pda: PublicKey;

  before(async () => {
    const airdrop = async (kp: Keypair) => {
      const sig = await connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
    };
    await airdrop(creator);
    await airdrop(platformFeeWallet);
    await airdrop(user1);
    await airdrop(user2);

    const providerWallet = provider.wallet;
    if (!providerWallet?.payer) throw new Error("Provider wallet needs payer for initialize");
    const [programConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    try {
      await program.methods
        .initialize(creator.publicKey)
        .accounts({
          programConfig,
          admin: providerWallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([providerWallet.payer])
        .rpc();
    } catch (err: any) {
      if (!err.message?.includes("already in use")) throw err;
    }

    await logBalances("Initial (after airdrop)", connection, [
      { name: "creator", pubkey: creator.publicKey },
      { name: "platformFeeWallet", pubkey: platformFeeWallet.publicKey },
      { name: "user1", pubkey: user1.publicKey },
    ]);
  });

  it("create_pool — verify pool state is initialized correctly", async () => {
    const poolIndex = 0;
    const targetNet = 5 * LAMPORTS_PER_SOL; // 5 SOL
    const minDeposit = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL
    const maxPerWallet = 10 * LAMPORTS_PER_SOL; // 10 SOL

    // Derive PDAs manually (must match program seeds exactly)
    const poolIndexBuf = new anchor.BN(poolIndex).toArrayLike(Buffer, "le", 8);
    const [poolState] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), creator.publicKey.toBuffer(), poolIndexBuf],
      program.programId
    );
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolState.toBuffer()],
      program.programId
    );
    poolStatePda = poolState;
    vaultPda = vault;

    await program.methods
      .createPool(
        new anchor.BN(poolIndex),
        new anchor.BN(targetNet),
        new anchor.BN(minDeposit),
        new anchor.BN(maxPerWallet)
      )
      .accountsStrict({
        poolState,
        vault,
        creator: creator.publicKey,
        platformFeeWallet: platformFeeWallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const pool = await poolStateAccount.fetch(poolState);
    expect(pool.creator.toString()).to.equal(creator.publicKey.toString());
    expect(pool.poolIndex.toString()).to.equal(poolIndex.toString());
    expect(pool.platformFeeWallet.toString()).to.equal(platformFeeWallet.publicKey.toString());
    expect(pool.targetNetLamports.toString()).to.equal(targetNet.toString());
    expect(pool.minDepositLamports.toString()).to.equal(minDeposit.toString());
    expect(pool.maxPerWalletLamports.toString()).to.equal(maxPerWallet.toString());
    expect(pool.totalContributedNetLamports.toString()).to.equal("0");
    expect(pool.bonusPoolLamports.toString()).to.equal("0");
    expect(pool.totalPendingFeesLamports.toString()).to.equal("0");
    expect(pool.status.filling).to.not.be.undefined;

    await logBalances("After create_pool", connection, [
      { name: "creator", pubkey: creator.publicKey },
      { name: "vault", pubkey: vault },
    ]);
  });

  it("init_contributor — verify contributor state created", async () => {
    const [contributor1] = PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), poolStatePda.toBuffer(), user1.publicKey.toBuffer()],
      PROGRAM_ID
    );
    contributor1Pda = contributor1;

    await program.methods
      .initContributor()
      .accounts({
        contributorState: contributor1,
        poolState: poolStatePda,
        user: user1.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    const contrib = await contributorStateAccount.fetch(contributor1);
    expect(contrib.contributedNetLamports.toString()).to.equal("0");
    expect(contrib.pendingFeeLamports.toString()).to.equal("0");

    await logBalances("After init_contributor (user1)", connection, [
      { name: "user1", pubkey: user1.publicKey },
    ]);
  });

  it("deposit — verify 4% platform, 1% pending in vault, 95% net", async () => {
    const grossAmount = 2 * LAMPORTS_PER_SOL; // 2 SOL (net=1.9, pending=0.02)
    const platformBefore = await getBalance(connection, platformFeeWallet.publicKey);
    const vaultBefore = await getBalance(connection, vaultPda);

    await program.methods
      .deposit(new anchor.BN(grossAmount))
      .accounts({
        poolState: poolStatePda,
        contributorState: contributor1Pda,
        vault: vaultPda,
        platformFeeWallet: platformFeeWallet.publicKey,
        user: user1.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    const platformAfter = await getBalance(connection, platformFeeWallet.publicKey);
    const vaultAfter = await getBalance(connection, vaultPda);

    const expectedPlatformFee = Math.floor((grossAmount * 4) / 100); // 4%
    const expectedPending = Math.floor((grossAmount * 1) / 100); // 1%
    const expectedNet = grossAmount - expectedPlatformFee - expectedPending; // 95%

    expect(platformAfter - platformBefore).to.equal(expectedPlatformFee);
    expect(vaultAfter - vaultBefore).to.equal(expectedNet + expectedPending);

    const pool = await poolStateAccount.fetch(poolStatePda);
    const contrib = await contributorStateAccount.fetch(contributor1Pda);

    expect(pool.totalContributedNetLamports.toString()).to.equal(expectedNet.toString());
    expect(pool.totalPendingFeesLamports.toString()).to.equal(expectedPending.toString());
    expect(contrib.contributedNetLamports.toString()).to.equal(expectedNet.toString());
    expect(contrib.pendingFeeLamports.toString()).to.equal(expectedPending.toString());

    await logBalances("After deposit", connection, [
      { name: "creator", pubkey: creator.publicKey },
      { name: "platformFeeWallet", pubkey: platformFeeWallet.publicKey },
      { name: "vault", pubkey: vaultPda },
      { name: "user1", pubkey: user1.publicKey },
    ]);
  });

  it("exit partial — verify proportional pending fee converted to bonus_pool", async () => {
    const poolBefore = await poolStateAccount.fetch(poolStatePda);
    const contribBefore = await contributorStateAccount.fetch(contributor1Pda);

    const withdrawNet = Number(contribBefore.contributedNetLamports) / 2;
    const user1Before = await getBalance(connection, user1.publicKey);

    await program.methods
      .exit(new anchor.BN(withdrawNet))
      .accounts({
        poolState: poolStatePda,
        contributorState: contributor1Pda,
        vault: vaultPda,
        user: user1.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    const contribAfter = await contributorStateAccount.fetch(contributor1Pda);
    const poolAfter = await poolStateAccount.fetch(poolStatePda);
    const user1After = await getBalance(connection, user1.publicKey);

    expect(Number(contribAfter.contributedNetLamports)).to.equal(
      Number(contribBefore.contributedNetLamports) - withdrawNet
    );
    expect(user1After - user1Before).to.equal(withdrawNet);

    const expectedConverted = Math.floor(
      (Number(contribBefore.pendingFeeLamports) * withdrawNet) /
        Number(contribBefore.contributedNetLamports)
    );
    expect(Number(poolAfter.bonusPoolLamports)).to.equal(expectedConverted);

    await logBalances("After exit partial", connection, [
      { name: "user1", pubkey: user1.publicKey },
      { name: "vault", pubkey: vaultPda },
    ]);
  });

  it("exit total — verify all pending becomes bonus", async () => {
    const contribBefore = await contributorStateAccount.fetch(contributor1Pda);
    const poolBefore = await poolStateAccount.fetch(poolStatePda);
    const withdrawNet = Number(contribBefore.contributedNetLamports);
    const pendingBefore = Number(contribBefore.pendingFeeLamports);

    await program.methods
      .exit(new anchor.BN(withdrawNet))
      .accounts({
        poolState: poolStatePda,
        contributorState: contributor1Pda,
        vault: vaultPda,
        user: user1.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    const contribAfter = await contributorStateAccount.fetch(contributor1Pda);
    const poolAfter = await poolStateAccount.fetch(poolStatePda);

    expect(Number(contribAfter.contributedNetLamports)).to.equal(0);
    expect(Number(contribAfter.pendingFeeLamports)).to.equal(0);
    expect(Number(poolAfter.bonusPoolLamports)).to.equal(
      Number(poolBefore.bonusPoolLamports) + pendingBefore
    );

    await logBalances("After exit total", connection, [
      { name: "user1", pubkey: user1.publicKey },
      { name: "vault", pubkey: vaultPda },
    ]);
  });

  it("deposit that triggers instant lock — verify status becomes Ready", async () => {
    const [contributor2] = PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), poolStatePda.toBuffer(), user2.publicKey.toBuffer()],
      PROGRAM_ID
    );
    contributor2Pda = contributor2;

    await program.methods
      .initContributor()
      .accounts({
        contributorState: contributor2,
        poolState: poolStatePda,
        user: user2.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user2])
      .rpc();

    const targetNet = 5 * LAMPORTS_PER_SOL;
    const poolBefore = await poolStateAccount.fetch(poolStatePda);
    const currentNet = Number(poolBefore.totalContributedNetLamports);
    const needed = targetNet - currentNet;

    const grossAmount = Math.ceil((needed / 0.95) * 1.01);
    await program.methods
      .deposit(new anchor.BN(grossAmount))
      .accounts({
        poolState: poolStatePda,
        contributorState: contributor2Pda,
        vault: vaultPda,
        platformFeeWallet: platformFeeWallet.publicKey,
        user: user2.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user2])
      .rpc();

    const pool = await poolStateAccount.fetch(poolStatePda);
    expect(pool.status.ready).to.not.be.undefined;
    expect(Number(pool.totalContributedNetLamports)).to.be.at.least(targetNet);

    await logBalances("After deposit (instant lock)", connection, [
      { name: "vault", pubkey: vaultPda },
      { name: "user2", pubkey: user2.publicKey },
    ]);
  });

  it("deposit after lock — must fail", async () => {
    try {
      await program.methods
        .deposit(new anchor.BN(1 * LAMPORTS_PER_SOL))
        .accounts({
          poolState: poolStatePda,
          contributorState: contributor2Pda,
          vault: vaultPda,
          platformFeeWallet: platformFeeWallet.publicKey,
          user: user2.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user2])
        .rpc();
      expect.fail("Should have thrown PoolNotFilling");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include("PoolNotFilling");
    }
  });

  it("withdraw_for_launch — verify launch_amount and pending to platform", async () => {
    const poolBefore = await poolStateAccount.fetch(poolStatePda);
    const launchWalletBefore = await getBalance(connection, creator.publicKey);
    const platformBefore = await getBalance(connection, platformFeeWallet.publicKey);

    const expectedLaunchAmount =
      Number(poolBefore.targetNetLamports) + Number(poolBefore.bonusPoolLamports);
    const expectedPlatformPending = Number(poolBefore.totalPendingFeesLamports);

    const [programConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    await program.methods
      .withdrawForLaunch()
      .accounts({
        programConfig,
        poolState: poolStatePda,
        vault: vaultPda,
        platformFeeWallet: platformFeeWallet.publicKey,
        launchWallet: creator.publicKey,
        caller: creator.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const launchWalletAfter = await getBalance(connection, creator.publicKey);
    const platformAfter = await getBalance(connection, platformFeeWallet.publicKey);
    const poolAfter = await poolStateAccount.fetch(poolStatePda);

    expect(launchWalletAfter - launchWalletBefore).to.equal(expectedLaunchAmount);
    expect(platformAfter - platformBefore).to.equal(expectedPlatformPending);
    expect(poolAfter.status.launched).to.not.be.undefined;

    await logBalances("After withdraw_for_launch", connection, [
      { name: "creator (launch_wallet)", pubkey: creator.publicKey },
      { name: "platformFeeWallet", pubkey: platformFeeWallet.publicKey },
      { name: "vault", pubkey: vaultPda },
    ]);
  });
});
