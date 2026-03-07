import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { WalletProvider } from "@/contexts/WalletProvider";
import { Navbar } from "@/components/Navbar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Stratton — Pool Launchpad",
  description: "Solana pool launchpad",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <WalletProvider>
          <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
            <Navbar />
            <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
