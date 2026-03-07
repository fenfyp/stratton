"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { idl, PROGRAM_ID } from "@/lib/idl";
import type { StrattonIDL } from "@/lib/idl";
import { getPool, upsertContributor } from "@/lib/supabase";
import type { Pool } from "@/lib/supabase";

const LAMPORTS_PER_SOL = 1_000_000_000;

type PoolStatus = "Filling" | "Ready" | "Launched" | "Cancelled";

function getStatusLabel(status: PoolStatus): string {
  const map: Record<PoolStatus, string> = {
    Filling: "FILLING",
    Ready: "READY",
    Launched: "LAUNCHED",
    Cancelled: "CANCELLED",
  };
  return map[status] ?? "UNKNOWN";
}

function getStatusColor(status: PoolStatus): string {
  const map: Record<PoolStatus, string> = {
    Filling: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    Ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
    Launched: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    Cancelled: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return map[status] ?? "bg-zinc-100 text-zinc-600";
}

export default function PoolPage() {
  const params = useParams();
  const pubkey = params.pubkey as string;
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();

  const [poolState, setPoolState] = useState<any>(null);
  const [metadata, setMetadata] = useState<Pool | null>(null);
  const [contributor, setContributor] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [depositAmount, setDepositAmount] = useState("");
  const [exitAmount, setExitAmount] = useState("");
  const [depositLoading, setDepositLoading] = useState(false);
  const [exitLoading, setExitLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [depositInfo, setDepositInfo] = useState<{ capped: boolean; actualSol: number } | null>(null);

  // Fees définis dans le smart contract (lib.rs)
  const TOTAL_FEE_BPS = 500;
  const BPS_BASE = 10_000;

  useEffect(() => {
    if (!pubkey) return;

    // Programme en lecture seule (pas besoin de signer pour fetch)
    const dummyWallet = {
      publicKey: PublicKey.default,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any[]) => txs,
    };
    const readonlyProvider = new AnchorProvider(connection, dummyWallet as any, {
      preflightCommitment: "confirmed",
    });
    const readonlyProgram = new Program(idl as StrattonIDL, readonlyProvider);

    async function fetchOnChain(isFirstLoad = false) {
      try {
        const poolStatePda = new PublicKey(pubkey);
        const pool = await (readonlyProgram.account as any).poolState.fetch(poolStatePda);
        setPoolState(pool);

        if (publicKey) {
          const [contributorPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("contributor"), poolStatePda.toBuffer(), publicKey.toBuffer()],
            PROGRAM_ID
          );
          try {
            const contrib = await (readonlyProgram.account as any).contributorState.fetch(contributorPda);
            setContributor(contrib);
          } catch {
            setContributor(null);
          }
        }
      } catch (err: any) {
        if (isFirstLoad) setError(err.message ?? "Failed to load pool");
      } finally {
        if (isFirstLoad) setLoading(false);
      }
    }

    async function initialLoad() {
      try {
        const meta = await getPool(pubkey);
        setMetadata(meta ?? null);
      } catch {
        // métadonnées non bloquantes
      }
      await fetchOnChain(true);
    }

    initialLoad();
    const interval = setInterval(() => fetchOnChain(false), 5_000);
    return () => clearInterval(interval);
  }, [pubkey, publicKey, connection]);

  async function handleDeposit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey || !signTransaction || !poolState) return;

    const sol = parseFloat(depositAmount);
    if (isNaN(sol) || sol <= 0) {
      setError("Enter a valid SOL amount.");
      return;
    }

    setDepositLoading(true);
    setError(null);
    setDepositInfo(null);

    // Capture le net actuel avant dépôt pour détecter un plafonnement
    const prevContributorNet = Number(contributor?.contributedNetLamports ?? 0);

    try {
      const provider = new AnchorProvider(
        connection,
        { publicKey, signTransaction } as any,
        { preflightCommitment: "confirmed" }
      );
      const program = new Program(idl as StrattonIDL, provider);

      const poolStatePda = new PublicKey(pubkey);
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), poolStatePda.toBuffer()],
        PROGRAM_ID
      );
      const [contributorPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("contributor"), poolStatePda.toBuffer(), publicKey.toBuffer()],
        PROGRAM_ID
      );

      const platformFeeWallet = new PublicKey(poolState.platformFeeWallet);
      const grossLamports = Math.floor(sol * LAMPORTS_PER_SOL);

      try {
        await program.methods
          .initContributor()
          .accounts({
            contributorState: contributorPda,
            poolState: poolStatePda,
            user: publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (err: any) {
        if (!err.message?.includes("already in use") && !err.message?.includes("0x0")) {
          throw err;
        }
      }

      await program.methods
        .deposit(new BN(grossLamports))
        .accounts({
          poolState: poolStatePda,
          contributorState: contributorPda,
          vault,
          platformFeeWallet,
          user: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const [updatedPool, updatedContrib] = await Promise.all([
        (program.account as any).poolState.fetch(poolStatePda),
        (program.account as any).contributorState.fetch(contributorPda),
      ]);
      setPoolState(updatedPool);
      setContributor(updatedContrib);
      setDepositAmount("");

      // Détecte si le dépôt a été plafonné par le contrat
      const expectedNet = Math.floor(grossLamports * (BPS_BASE - TOTAL_FEE_BPS) / BPS_BASE);
      const actualNetAdded = Number(updatedContrib.contributedNetLamports) - prevContributorNet;
      const wasCapped = actualNetAdded < expectedNet;
      setDepositInfo({ capped: wasCapped, actualSol: actualNetAdded / LAMPORTS_PER_SOL });

      // Enregistre le contributeur dans Supabase pour la distribution future des tokens
      upsertContributor(pubkey, publicKey.toBase58()).catch((err) => {
        console.warn("upsertContributor failed (non-blocking):", err.message);
      });
    } catch (err: any) {
      setError(err.message ?? "Deposit failed");
    } finally {
      setDepositLoading(false);
    }
  }

  async function handleExit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey || !signTransaction || !poolState || !contributor) return;

    const sol = parseFloat(exitAmount);
    const maxWithdraw = Number(contributor.contributedNetLamports) / LAMPORTS_PER_SOL;
    if (isNaN(sol) || sol <= 0 || sol > maxWithdraw) {
      setError(`Enter a valid amount (max ${maxWithdraw.toFixed(4)} SOL).`);
      return;
    }

    setExitLoading(true);
    setError(null);

    try {
      const provider = new AnchorProvider(
        connection,
        { publicKey, signTransaction } as any,
        { preflightCommitment: "confirmed" }
      );
      const program = new Program(idl as StrattonIDL, provider);

      const poolStatePda = new PublicKey(pubkey);
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), poolStatePda.toBuffer()],
        PROGRAM_ID
      );
      const [contributorPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("contributor"), poolStatePda.toBuffer(), publicKey.toBuffer()],
        PROGRAM_ID
      );

      const withdrawLamports = Math.floor(sol * LAMPORTS_PER_SOL);

      await program.methods
        .exit(new BN(withdrawLamports))
        .accounts({
          poolState: poolStatePda,
          contributorState: contributorPda,
          vault,
          user: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const [updatedPool, updatedContrib] = await Promise.all([
        (program.account as any).poolState.fetch(poolStatePda),
        (program.account as any).contributorState.fetch(contributorPda),
      ]);
      setPoolState(updatedPool);
      setContributor(Number(updatedContrib.contributedNetLamports) === 0 ? null : updatedContrib);
      setExitAmount("");
    } catch (err: any) {
      setError(err.message ?? "Exit failed");
    } finally {
      setExitLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-zinc-600 dark:text-zinc-400">Loading pool...</p>
      </div>
    );
  }

  if (error && !poolState) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-red-600 dark:text-red-400">{error}</p>
        <Link href="/" className="mt-4 inline-block text-sm font-medium text-zinc-900 dark:text-zinc-50">
          ← Back home
        </Link>
      </div>
    );
  }

  const status: PoolStatus = poolState?.status?.filling
    ? "Filling"
    : poolState?.status?.ready
      ? "Ready"
      : poolState?.status?.launched
        ? "Launched"
        : poolState?.status?.cancelled
          ? "Cancelled"
          : "Filling";

  const targetLamports = Number(poolState?.targetNetLamports ?? 0);
  const contributedLamports = Number(poolState?.totalContributedNetLamports ?? 0);
  const progress = targetLamports > 0 ? (contributedLamports / targetLamports) * 100 : 0;

  const canDeposit = status === "Filling" && publicKey;
  const canExit = (status === "Filling" || status === "Ready") && contributor && Number(contributor.contributedNetLamports) > 0;

  return (
    <div className="flex flex-col gap-8">
      <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
        ← Back to pools
      </Link>

      <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            {metadata?.image_url && (
              <img
                src={metadata.image_url}
                alt={metadata?.name ?? "Pool"}
                className="h-16 w-16 shrink-0 rounded-xl object-cover border border-zinc-200 dark:border-zinc-700"
              />
            )}
            <div>
              <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                {metadata?.name ?? "Unnamed Pool"}
              </h1>
            {metadata?.ticker && (
              <p className="mt-1 text-sm font-mono text-zinc-600 dark:text-zinc-400">
                ${metadata.ticker}
              </p>
            )}
            {metadata?.description && (
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                {metadata.description}
              </p>
            )}
            {metadata?.creator_wallet && (
              <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
                Created by{" "}
                <span className="font-mono">
                  {metadata.creator_wallet.slice(0, 4)}…{metadata.creator_wallet.slice(-4)}
                </span>
              </p>
            )}
            </div>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${getStatusColor(status)}`}
          >
            {getStatusLabel(status)}
          </span>
        </div>

        <div className="mt-6">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Progress</span>
            <span className="font-medium text-zinc-900 dark:text-zinc-50">
              {(contributedLamports / LAMPORTS_PER_SOL).toFixed(2)} / {(targetLamports / LAMPORTS_PER_SOL).toFixed(2)} SOL
            </span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
        </div>

        {status === "Launched" && metadata?.pump_fun_url && (
          <div className="mt-6">
            <a
              href={metadata.pump_fun_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
            >
              View on Pump.fun →
            </a>
          </div>
        )}

        {error && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {depositInfo && (
          <div className={`mt-6 rounded-lg px-4 py-3 text-sm ${
            depositInfo.capped
              ? "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
              : "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
          }`}>
            {depositInfo.capped ? (
              <>
                <span className="font-semibold">Deposit capped.</span>{" "}
                The pool was nearly full — only{" "}
                <span className="font-semibold">{depositInfo.actualSol.toFixed(4)} SOL</span>{" "}
                (net) was accepted. The surplus stayed in your wallet.
              </>
            ) : (
              <>
                <span className="font-semibold">Deposit confirmed.</span>{" "}
                <span className="font-semibold">{depositInfo.actualSol.toFixed(4)} SOL</span>{" "}
                added to your contribution.
              </>
            )}
          </div>
        )}

        {canDeposit && (
          <form onSubmit={handleDeposit} className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
            <h3 className="font-medium text-zinc-900 dark:text-zinc-50">Deposit</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Min: {(Number(poolState.minDepositLamports) / LAMPORTS_PER_SOL).toFixed(2)} SOL · Max per wallet: {(Number(poolState.maxPerWalletLamports) / LAMPORTS_PER_SOL).toFixed(2)} SOL
            </p>
            <div className="mt-3 flex gap-2">
              <input
                type="number"
                step="0.01"
                min="0"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
                placeholder="Amount in SOL"
              />
              <button
                type="submit"
                disabled={depositLoading}
                className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {depositLoading ? "..." : "Deposit"}
              </button>
            </div>
          </form>
        )}

        {canExit && (
          <form onSubmit={handleExit} className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
            <h3 className="font-medium text-zinc-900 dark:text-zinc-50">Exit</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Your balance: {(Number(contributor.contributedNetLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL
            </p>
            <div className="mt-3 flex gap-2">
              <input
                type="number"
                step="0.0001"
                min="0"
                max={Number(contributor.contributedNetLamports) / LAMPORTS_PER_SOL}
                value={exitAmount}
                onChange={(e) => setExitAmount(e.target.value)}
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
                placeholder="Amount to withdraw"
              />
              <button
                type="submit"
                disabled={exitLoading}
                className="rounded-lg border border-zinc-300 px-4 py-2 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {exitLoading ? "..." : "Exit"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
