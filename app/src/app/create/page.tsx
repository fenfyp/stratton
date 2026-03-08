"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { idl, PROGRAM_ID } from "@/lib/idl";
import type { StrattonIDL } from "@/lib/idl";
import { savePools, uploadTokenImage, updatePoolImage } from "@/lib/supabase";

const LAMPORTS_PER_SOL = 1_000_000_000;

export default function CreatePoolPage() {
  const router = useRouter();
  const { publicKey, signTransaction, signMessage } = useWallet();
  const { connection } = useConnection();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [targetSol, setTargetSol] = useState("");
  const [minDepositSol, setMinDepositSol] = useState("");
  const [maxPerWalletSol, setMaxPerWalletSol] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const platformFeeWallet = process.env.NEXT_PUBLIC_PLATFORM_FEE_WALLET;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey || !signTransaction || !platformFeeWallet) {
      setError("Connect your wallet and ensure platform fee wallet is configured.");
      return;
    }

    const target = parseFloat(targetSol);
    const minDep = parseFloat(minDepositSol);
    const maxPer = parseFloat(maxPerWalletSol);

    if (isNaN(target) || target <= 0 || isNaN(minDep) || minDep < 0 || isNaN(maxPer) || maxPer <= 0) {
      setError("Invalid SOL amounts.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const provider = new AnchorProvider(
        connection,
        { publicKey, signTransaction } as any,
        { preflightCommitment: "confirmed" }
      );
      const program = new Program(idl as StrattonIDL, provider);

      const poolIndex = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      const poolIndexBuf = new BN(poolIndex).toArrayLike(Buffer as any, "le", 8);

      const [poolState] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), publicKey.toBuffer(), poolIndexBuf],
        PROGRAM_ID
      );
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), poolState.toBuffer()],
        PROGRAM_ID
      );

      const targetLamports = Math.floor(target * LAMPORTS_PER_SOL);
      const minLamports = Math.floor(minDep * LAMPORTS_PER_SOL);
      const maxLamports = Math.floor(maxPer * LAMPORTS_PER_SOL);

      await program.methods
        .createPool(new BN(poolIndex), new BN(targetLamports), new BN(minLamports), new BN(maxLamports))
        .accounts({
          poolState,
          vault,
          creator: publicKey,
          platformFeeWallet: new PublicKey(platformFeeWallet),
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await savePools({
        pubkey: poolState.toBase58(),
        name: name.trim() || "Unnamed Pool",
        ticker: ticker.trim() || null,
        description: description.trim() || null,
        creator_wallet: publicKey.toBase58(),
        pump_fun_url: null,
        mint_address: null,
        image_url: null,
        created_at: new Date().toISOString(),
        last_deposit_at: null,
      });

      if (imageFile) {
        try {
          if (!signMessage) {
            throw new Error("Your wallet does not support message signing. Please use a wallet that supports signing (e.g. Phantom).");
          }
          const message = `Upload image for pool ${poolState.toBase58()}`;
          const signature = await signMessage(new TextEncoder().encode(message));
          const imageUrl = await uploadTokenImage(
            imageFile,
            ticker.trim() || null,
            poolState.toBase58(),
            message,
            signature
          );
          await updatePoolImage(poolState.toBase58(), imageUrl);
        } catch (uploadErr: any) {
          console.warn("Image upload failed, pool saved without image:", uploadErr?.message);
        }
      }

      router.push(`/pool/${poolState.toBase58()}`);
    } catch (err: any) {
      setError(err.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  if (!publicKey) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-zinc-600 dark:text-zinc-400">
          Connect your wallet to create a pool.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm font-medium text-zinc-900 dark:text-zinc-50">
          ← Back home
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          Create Pool
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Launch a new pool on Solana.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
              placeholder="My Pool"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Ticker
            </label>
            <input
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
              placeholder="MPOOL"
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Token Image
          </label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setImageFile(file);
                const reader = new FileReader();
                reader.onload = () => setImagePreview(reader.result as string);
                reader.readAsDataURL(file);
              } else {
                setImageFile(null);
                setImagePreview(null);
              }
            }}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
          />
          {imagePreview && (
            <div className="mt-2">
              <img
                src={imagePreview}
                alt="Preview"
                className="h-24 w-24 rounded-lg object-cover border border-zinc-200 dark:border-zinc-700"
              />
            </div>
          )}
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
            placeholder="Description of your pool..."
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Target SOL
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={targetSol}
              onChange={(e) => setTargetSol(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
              placeholder="100"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Min deposit SOL
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={minDepositSol}
              onChange={(e) => setMinDepositSol(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
              placeholder="0.1"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Max per wallet SOL
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={maxPerWalletSol}
              onChange={(e) => setMaxPerWalletSol(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
              placeholder="10"
              required
            />
          </div>
        </div>

        {error && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="mt-6 flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loading ? "Creating..." : "Create Pool"}
          </button>
          <Link
            href="/"
            className="rounded-lg border border-zinc-300 px-4 py-2 font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
