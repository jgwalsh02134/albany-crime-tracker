"use client";

/**
 * ScannerShell — client component that wraps the scanner page layout.
 */

import type { ScannerCall, ScannerChannel } from "../types";
import Header from "../components/Header";
import BottomNav from "../components/BottomNav";
import ScannerCards from "../components/ScannerCards";

interface ScannerShellProps {
  initialCalls: ScannerCall[];
  channels: ScannerChannel[];
}

export default function ScannerShell({ initialCalls, channels }: ScannerShellProps) {
  return (
    <>
      <Header />

      <main className="main-content">
        <ScannerCards initialCalls={initialCalls} channels={channels} />
      </main>

      <BottomNav />
    </>
  );
}
