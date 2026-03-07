import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PublicKey } from "npm:@solana/web3.js@1.98.4";
import nacl from "npm:tweetnacl@1.0.3";

const TOKEN_IMAGES_BUCKET = "token-images";
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB

// Try both formats: raw (Phantom) and Solana standard prefix (some wallets)
function getMessageBytesForVerification(message: string): Uint8Array[] {
  const raw = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode("\x19Solana Signed Message:\n");
  const lengthBytes = new Uint8Array(8);
  new DataView(lengthBytes.buffer).setBigUint64(0, BigInt(raw.length), true);
  const withPrefix = new Uint8Array(prefix.length + lengthBytes.length + raw.length);
  withPrefix.set(prefix, 0);
  withPrefix.set(lengthBytes, prefix.length);
  withPrefix.set(raw, prefix.length + lengthBytes.length);
  return [raw, withPrefix];
}

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(req.headers.get("Origin")) });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders(req.headers.get("Origin")), "Content-Type": "application/json" } }
    );
  }

  const origin = req.headers.get("Origin");

  try {
    const formData = await req.formData();
    const image = formData.get("image") as File | null;
    const poolPubkey = formData.get("poolPubkey") as string | null;
    const ticker = formData.get("ticker") as string | null;
    const message = formData.get("message") as string | null;
    const signatureBase64 = formData.get("signature") as string | null;

    if (!image || !poolPubkey || !message || !signatureBase64) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: image, poolPubkey, message, signature" }),
        { status: 400, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    if (image.size > MAX_IMAGE_SIZE) {
      return new Response(
        JSON.stringify({ error: "Image too large (max 5 MB)" }),
        { status: 400, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: pool, error: poolError } = await supabase
      .from("pools")
      .select("creator_wallet")
      .eq("pubkey", poolPubkey)
      .single();

    if (poolError || !pool?.creator_wallet) {
      return new Response(
        JSON.stringify({ error: "Pool not found" }),
        { status: 404, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    const creator = new PublicKey(pool.creator_wallet);
    const signature = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));

    const messageVariants = getMessageBytesForVerification(message);
    const verified = messageVariants.some((msgBytes) =>
      nacl.sign.detached.verify(msgBytes, signature, creator.toBytes())
    );

    if (!verified) {
      return new Response(
        JSON.stringify({ error: "Invalid signature: creator did not sign the message" }),
        { status: 401, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    const ext = image.name.split(".").pop()?.toLowerCase() || "png";
    const safeTicker = (ticker?.trim() || "token").replace(/[^a-zA-Z0-9-_]/g, "_");
    const filename = `${Date.now()}-${safeTicker}.${ext}`;

    const arrayBuffer = await image.arrayBuffer();
    const { error } = await supabase.storage.from(TOKEN_IMAGES_BUCKET).upload(filename, arrayBuffer, {
      contentType: image.type || "image/png",
      cacheControl: "3600",
      upsert: true,
    });

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    const { data: urlData } = supabase.storage.from(TOKEN_IMAGES_BUCKET).getPublicUrl(filename);
    return new Response(
      JSON.stringify({ imageUrl: urlData.publicUrl }),
      { status: 200, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
