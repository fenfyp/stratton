import { Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import strattonIdl from "./stratton-idl.json";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "3ged954nQvfoyxzbRfKj1AtkR7UsPEHKggzhid5QE4EL"
);

export type StrattonIDL = typeof strattonIdl;
export const idl = strattonIdl as Idl;
