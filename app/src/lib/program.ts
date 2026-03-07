"use client";

import { useMemo } from "react";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { idl } from "./idl";

export function useProgram(): Program | null {
  const { connection } = useConnection();
  const wallet = useWallet();

  return useMemo(() => {
    if (!wallet.publicKey) return null;
    const provider = new AnchorProvider(
      connection,
      wallet as any,
      { preflightCommitment: "confirmed" }
    );
    return new Program(idl as any, provider);
  }, [connection, wallet]);
}
