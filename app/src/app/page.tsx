"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { idl, PROGRAM_ID } from "@/lib/idl";
import type { StrattonIDL } from "@/lib/idl";
import { getPools } from "@/lib/supabase";
import type { Pool } from "@/lib/supabase";

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

type PoolWithState = Pool & {
  targetLamports?: number;
  contributedLamports?: number;
  status?: PoolStatus;
};

export default function HomePage() {
  const { connection } = useConnection();
  const [pools, setPools] = useState<PoolWithState[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const dummyWallet = {
      publicKey: PublicKey.default,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any[]) => txs,
    };
    const provider = new AnchorProvider(connection, dummyWallet as any, {
      preflightCommitment: "confirmed",
    });
    const program = new Program(idl as StrattonIDL, provider);

    async function load(isFirstLoad = false) {
      try {
        const metaList = await getPools();

        const poolsWithState: PoolWithState[] = await Promise.all(
          metaList.map(async (meta) => {
            try {
              const poolState = await (program.account as any).poolState.fetch(
                new PublicKey(meta.pubkey)
              );
              const status: PoolStatus = (poolState.status as any)?.filling
                ? "Filling"
                : (poolState.status as any)?.ready
                  ? "Ready"
                  : (poolState.status as any)?.launched
                    ? "Launched"
                    : (poolState.status as any)?.cancelled
                      ? "Cancelled"
                      : "Filling";
              return {
                ...meta,
                targetLamports: Number(poolState.targetNetLamports),
                contributedLamports: Number(poolState.totalContributedNetLamports),
                status,
              };
            } catch {
              return { ...meta };
            }
          })
        );

        setPools(poolsWithState);
      } catch (err) {
        console.error(err);
        if (isFirstLoad) setPools([]);
      } finally {
        if (isFirstLoad) setLoading(false);
      }
    }

    load(true);
    const interval = setInterval(() => load(false), 10_000);
    return () => clearInterval(interval);
  }, [connection]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            Pool Launchpad
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Create and participate in Solana pools.
          </p>
        </div>
        <Link
          href="/create"
          className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Create Pool
        </Link>
      </div>

      {loading ? (
        <p className="text-zinc-600 dark:text-zinc-400">Loading pools...</p>
      ) : pools.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-12 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-zinc-600 dark:text-zinc-400">
            No pools yet. Create the first one!
          </p>
          <Link
            href="/create"
            className="mt-4 inline-block rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Create Pool
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pools.map((pool) => {
            const target = pool.targetLamports ?? 0;
            const contributed = pool.contributedLamports ?? 0;
            const progress = target > 0 ? (contributed / target) * 100 : 0;
            const status = pool.status ?? "Filling";

            return (
              <Link
                key={pool.pubkey}
                href={`/pool/${pool.pubkey}`}
                className="block rounded-xl border border-zinc-200 bg-white p-5 transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:shadow-zinc-900/50"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    {pool.image_url && (
                      <img
                        src={pool.image_url}
                        alt={pool.name}
                        className="h-10 w-10 shrink-0 rounded-lg object-cover border border-zinc-200 dark:border-zinc-700"
                      />
                    )}
                    <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">
                      {pool.name}
                    </h2>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${getStatusColor(status)}`}
                  >
                    {getStatusLabel(status)}
                  </span>
                </div>
                {pool.ticker && (
                  <p className="mt-1 text-sm font-mono text-zinc-500 dark:text-zinc-400">
                    ${pool.ticker}
                  </p>
                )}
                {pool.creator_wallet && (
                  <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                    Created by{" "}
                    <span className="font-mono">
                      {pool.creator_wallet.slice(0, 4)}…{pool.creator_wallet.slice(-4)}
                    </span>
                  </p>
                )}
                <div className="mt-4">
                  <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400">
                    <span>Progress</span>
                    <span>
                      {(contributed / 1e9).toFixed(2)} / {(target / 1e9).toFixed(2)} SOL
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${Math.min(progress, 100)}%` }}
                    />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
