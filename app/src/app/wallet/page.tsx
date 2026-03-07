"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { idl, PROGRAM_ID } from "@/lib/idl";
import type { StrattonIDL } from "@/lib/idl";
import { getContributedPools } from "@/lib/supabase";
import { supabase } from "@/lib/supabase";

const LAMPORTS_PER_SOL = 1_000_000_000;

type PoolStatus = "Filling" | "Ready" | "Launched" | "Cancelled";

interface PoolEntry {
  pubkey: string;
  name: string;
  ticker: string | null;
  image_url: string | null;
  pump_fun_url: string | null;
  mint_address: string | null;
  status: PoolStatus;
  contributedNetLamports: number;
  tokenBalance: bigint | null;
}

function getStatusLabel(status: PoolStatus) {
  const map: Record<PoolStatus, string> = {
    Filling: "FILLING",
    Ready: "READY",
    Launched: "LAUNCHED",
    Cancelled: "CANCELLED",
  };
  return map[status] ?? "UNKNOWN";
}

function getStatusColor(status: PoolStatus) {
  const map: Record<PoolStatus, string> = {
    Filling: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    Ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
    Launched: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    Cancelled: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return map[status] ?? "bg-zinc-100 text-zinc-600";
}

function formatTokens(amount: bigint): string {
  // Les tokens pump.fun ont 6 décimales
  const decimals = 6;
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  if (frac === 0n) return whole.toLocaleString();
  return `${whole.toLocaleString()}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

export default function WalletPage() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();

  const [pools, setPools] = useState<PoolEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey) {
      setLoading(false);
      return;
    }

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // 1. Récupère tous les pools auxquels le wallet a contribué
        const poolPubkeys = await getContributedPools(publicKey!.toBase58());

        if (poolPubkeys.length === 0) {
          setPools([]);
          setLoading(false);
          return;
        }

        // 2. Métadonnées Supabase pour ces pools
        const { data: metaList, error: sbError } = await supabase
          .from("pools")
          .select("pubkey, name, ticker, image_url, pump_fun_url, mint_address")
          .in("pubkey", poolPubkeys);

        if (sbError) throw new Error(sbError.message);

        // 3. Initialise le programme Anchor (lecture seule si wallet pas connecté)
        const wallet = publicKey && signTransaction
          ? { publicKey, signTransaction } as any
          : {
              publicKey: PublicKey.default,
              signTransaction: async (tx: any) => tx,
              signAllTransactions: async (txs: any[]) => txs,
            };
        const provider = new AnchorProvider(connection, wallet, { preflightCommitment: "confirmed" });
        const program = new Program(idl as StrattonIDL, provider);

        // 4. Pour chaque pool, fetch on-chain + balance de token si launched
        const entries: PoolEntry[] = await Promise.all(
          (metaList ?? []).map(async (meta) => {
            let status: PoolStatus = "Filling";
            let contributedNetLamports = 0;
            let tokenBalance: bigint | null = null;

            try {
              const poolStatePk = new PublicKey(meta.pubkey);

              // Statut on-chain du pool
              const poolState = await (program.account as any).poolState.fetch(poolStatePk);
              status = (poolState.status as any)?.filling
                ? "Filling"
                : (poolState.status as any)?.ready
                  ? "Ready"
                  : (poolState.status as any)?.launched
                    ? "Launched"
                    : (poolState.status as any)?.cancelled
                      ? "Cancelled"
                      : "Filling";

              // Contribution on-chain du wallet connecté
              const [contributorPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("contributor"), poolStatePk.toBuffer(), publicKey!.toBuffer()],
                PROGRAM_ID
              );
              try {
                const contrib = await (program.account as any).contributorState.fetch(contributorPda);
                contributedNetLamports = Number(contrib.contributedNetLamports);
              } catch {
                contributedNetLamports = 0;
              }

              // Balance du token si le pool est Launched et a un mint
              if (status === "Launched" && meta.mint_address) {
                try {
                  const mintPk = new PublicKey(meta.mint_address);
                  const ata = getAssociatedTokenAddressSync(mintPk, publicKey!);
                  const ataAccount = await getAccount(connection, ata);
                  tokenBalance = ataAccount.amount;
                } catch {
                  tokenBalance = 0n;
                }
              }
            } catch {
              // Pool non trouvée on-chain — on garde les valeurs par défaut
            }

            return {
              pubkey: meta.pubkey,
              name: meta.name,
              ticker: meta.ticker,
              image_url: meta.image_url,
              pump_fun_url: meta.pump_fun_url,
              mint_address: meta.mint_address,
              status,
              contributedNetLamports,
              tokenBalance,
            };
          })
        );

        // Tri : launched en premier, puis filling/ready, puis cancelled
        entries.sort((a, b) => {
          const order: Record<PoolStatus, number> = { Launched: 0, Ready: 1, Filling: 2, Cancelled: 3 };
          return order[a.status] - order[b.status];
        });

        setPools(entries);
      } catch (err: any) {
        setError(err.message ?? "Failed to load wallet data");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [publicKey, signTransaction, connection]);

  // ─── Wallet non connecté ──────────────────────────────────────────────────────
  if (!publicKey) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-zinc-200 bg-white p-16 text-center dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
          <svg className="h-7 w-7 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M21 12a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18-3a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
          </svg>
        </div>
        <div>
          <p className="font-semibold text-zinc-900 dark:text-zinc-50">Connect your wallet</p>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Connect your Solana wallet to see your contributions and tokens.
          </p>
        </div>
      </div>
    );
  }

  // ─── Chargement ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <WalletHeader address={publicKey.toBase58()} />
        <div className="grid gap-4 sm:grid-cols-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800" />
          ))}
        </div>
      </div>
    );
  }

  // ─── Erreur ───────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex flex-col gap-8">
        <WalletHeader address={publicKey.toBase58()} />
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 dark:border-red-900/40 dark:bg-red-950/20">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  const activePools = pools.filter((p) => p.status === "Filling" || p.status === "Ready");
  const launchedPools = pools.filter((p) => p.status === "Launched");
  const cancelledPools = pools.filter((p) => p.status === "Cancelled");

  return (
    <div className="flex flex-col gap-8">
      <WalletHeader address={publicKey.toBase58()} />

      {pools.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-12 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-zinc-600 dark:text-zinc-400">
            You haven&apos;t contributed to any pool yet.
          </p>
          <Link
            href="/"
            className="mt-4 inline-block rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Browse Pools
          </Link>
        </div>
      ) : (
        <>
          {/* Tokens reçus */}
          {launchedPools.length > 0 && (
            <section className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                My Tokens
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {launchedPools.map((pool) => (
                  <TokenCard key={pool.pubkey} pool={pool} />
                ))}
              </div>
            </section>
          )}

          {/* Contributions actives */}
          {activePools.length > 0 && (
            <section className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Active Contributions
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {activePools.map((pool) => (
                  <ContributionCard key={pool.pubkey} pool={pool} />
                ))}
              </div>
            </section>
          )}

          {/* Pools annulées */}
          {cancelledPools.length > 0 && (
            <section className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-zinc-500 dark:text-zinc-400">
                Cancelled
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {cancelledPools.map((pool) => (
                  <ContributionCard key={pool.pubkey} pool={pool} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ─── Sous-composants ─────────────────────────────────────────────────────────

function WalletHeader({ address }: { address: string }) {
  const short = `${address.slice(0, 4)}...${address.slice(-4)}`;
  return (
    <div>
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">My Wallet</h1>
      <p className="mt-1 font-mono text-sm text-zinc-500 dark:text-zinc-400">{short}</p>
    </div>
  );
}

function TokenCard({ pool }: { pool: PoolEntry }) {
  const hasTokens = pool.tokenBalance !== null && pool.tokenBalance > 0n;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          {pool.image_url && (
            <img
              src={pool.image_url}
              alt={pool.name}
              className="h-11 w-11 shrink-0 rounded-xl border border-zinc-200 object-cover dark:border-zinc-700"
            />
          )}
          <div>
            <p className="font-semibold text-zinc-900 dark:text-zinc-50">{pool.name}</p>
            {pool.ticker && (
              <p className="font-mono text-xs text-zinc-500 dark:text-zinc-400">${pool.ticker}</p>
            )}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${getStatusColor("Launched")}`}>
          LAUNCHED
        </span>
      </div>

      {/* Balance tokens */}
      <div className="rounded-lg bg-blue-50 px-4 py-3 dark:bg-blue-950/30">
        {hasTokens ? (
          <>
            <p className="text-xs text-blue-600 dark:text-blue-400">Token balance</p>
            <p className="mt-0.5 text-xl font-bold text-blue-700 dark:text-blue-300">
              {formatTokens(pool.tokenBalance!)}
            </p>
            {pool.ticker && (
              <p className="font-mono text-xs text-blue-500 dark:text-blue-500">${pool.ticker}</p>
            )}
          </>
        ) : pool.mint_address ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            No tokens received yet — distribution may be pending.
          </p>
        ) : (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Token launch in progress...
          </p>
        )}
      </div>

      {/* Contribution SOL */}
      {pool.contributedNetLamports > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Contributed:{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {(pool.contributedNetLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL
          </span>
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <Link
          href={`/pool/${pool.pubkey}`}
          className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-center text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Pool details
        </Link>
        {pool.pump_fun_url && pool.pump_fun_url !== "https://pump.fun (coming soon)" && (
          <a
            href={pool.pump_fun_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-blue-700"
          >
            View on Pump.fun →
          </a>
        )}
      </div>
    </div>
  );
}

function ContributionCard({ pool }: { pool: PoolEntry }) {
  const isCancelled = pool.status === "Cancelled";

  return (
    <Link
      href={`/pool/${pool.pubkey}`}
      className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-5 transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:shadow-zinc-900/50"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          {pool.image_url && (
            <img
              src={pool.image_url}
              alt={pool.name}
              className="h-11 w-11 shrink-0 rounded-xl border border-zinc-200 object-cover dark:border-zinc-700"
            />
          )}
          <div>
            <p className="font-semibold text-zinc-900 dark:text-zinc-50">{pool.name}</p>
            {pool.ticker && (
              <p className="font-mono text-xs text-zinc-500 dark:text-zinc-400">${pool.ticker}</p>
            )}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${getStatusColor(pool.status)}`}>
          {getStatusLabel(pool.status)}
        </span>
      </div>

      <div className={`rounded-lg px-4 py-3 ${isCancelled ? "bg-zinc-100 dark:bg-zinc-800" : "bg-emerald-50 dark:bg-emerald-950/20"}`}>
        <p className={`text-xs ${isCancelled ? "text-zinc-500" : "text-emerald-600 dark:text-emerald-400"}`}>
          {isCancelled ? "Contributed" : "Active contribution"}
        </p>
        <p className={`mt-0.5 text-xl font-bold ${isCancelled ? "text-zinc-500 dark:text-zinc-400" : "text-emerald-700 dark:text-emerald-300"}`}>
          {(pool.contributedNetLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL
        </p>
      </div>

      {!isCancelled && pool.status === "Filling" && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Click to deposit more or exit the pool.
        </p>
      )}
    </Link>
  );
}
