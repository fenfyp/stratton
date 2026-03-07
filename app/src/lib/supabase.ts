import { createClient } from "@supabase/supabase-js";
import imageCompression from "browser-image-compression";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface Pool {
  pubkey: string;
  name: string;
  ticker: string | null;
  description: string | null;
  creator_wallet: string;
  pump_fun_url: string | null;
  mint_address: string | null;
  image_url: string | null;
  created_at: string;
  last_deposit_at: string | null;
}

export interface PoolContributor {
  pool_pubkey: string;
  wallet: string;
  created_at: string;
}

const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

export async function uploadTokenImage(
  file: File,
  ticker: string | null,
  poolPubkey: string,
  message: string,
  signature: Uint8Array
): Promise<string> {
  let fileToUpload = file;
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    fileToUpload = await imageCompression(file, {
      maxSizeMB: 2,
      maxWidthOrHeight: 1024,
      useWebWorker: true,
    });
  }

  const formData = new FormData();
  formData.append("image", fileToUpload);
  formData.append("poolPubkey", poolPubkey);
  formData.append("ticker", ticker?.trim() || "");
  formData.append("message", message);
  formData.append("signature", btoa(String.fromCharCode(...signature)));

  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/upload-token-image`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Upload failed");
  }

  const { imageUrl } = await res.json();
  return imageUrl;
}

export async function savePools(pools: Pool | Pool[]): Promise<void> {
  const rows = Array.isArray(pools) ? pools : [pools];
  const { error } = await supabase.from("pools").upsert(rows, {
    onConflict: "pubkey",
  });
  if (error) throw error;
}

export async function updatePoolImage(pubkey: string, imageUrl: string): Promise<void> {
  const { error } = await supabase
    .from("pools")
    .update({ image_url: imageUrl })
    .eq("pubkey", pubkey);
  if (error) throw error;
}

export async function getPool(pubkey: string): Promise<Pool | null> {
  const { data, error } = await supabase
    .from("pools")
    .select("*")
    .eq("pubkey", pubkey)
    .single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }
  return data as Pool;
}

/**
 * Enregistre un contributeur pour une pool (upsert — ignore si déjà présent).
 */
export async function upsertContributor(poolPubkey: string, wallet: string): Promise<void> {
  const { error } = await supabase
    .from("pool_contributors")
    .upsert({ pool_pubkey: poolPubkey, wallet }, { onConflict: "pool_pubkey,wallet", ignoreDuplicates: true });
  if (error) throw error;
}

/**
 * Retourne tous les contributeurs d'une pool (filtrage par pool_pubkey).
 */
export async function getContributors(poolPubkey: string): Promise<PoolContributor[]> {
  const { data, error } = await supabase
    .from("pool_contributors")
    .select("*")
    .eq("pool_pubkey", poolPubkey);
  if (error) throw error;
  return (data ?? []) as PoolContributor[];
}

/**
 * Retourne tous les pool_pubkey auxquels un wallet a contribué (filtrage par wallet).
 */
export async function getContributedPools(wallet: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("pool_contributors")
    .select("pool_pubkey")
    .eq("wallet", wallet);
  if (error) throw error;
  return (data ?? []).map((row) => row.pool_pubkey as string);
}

export async function getPools(): Promise<Pool[]> {
  const { data, error } = await supabase
    .from("pools")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Pool[];
}
