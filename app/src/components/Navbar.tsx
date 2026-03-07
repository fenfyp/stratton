"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton
    ),
  { ssr: false }
);

export function Navbar() {
  const pathname = usePathname();

  function navClass(href: string) {
    const active = pathname === href;
    return `text-sm font-medium transition-colors ${
      active
        ? "text-zinc-900 dark:text-zinc-50"
        : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
    }`;
  }

  return (
    <nav className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50"
        >
          <img src="/logo.png" alt="Stratton" className="h-11 w-11 rounded-full object-cover" />
          Stratton
        </Link>
        <Link href="/create" className={navClass("/create")}>
          Create Pool
        </Link>
        <Link href="/wallet" className={navClass("/wallet")}>
          My Wallet
        </Link>
      </div>
      <WalletMultiButton className="!bg-zinc-900 !rounded-lg hover:!bg-zinc-800 dark:!bg-zinc-50 dark:hover:!bg-zinc-200 dark:!text-zinc-900" />
    </nav>
  );
}
