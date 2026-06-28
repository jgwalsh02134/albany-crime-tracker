"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface HeaderProps {
  onFilterOpen?: () => void;
}

export default function Header({ onFilterOpen }: HeaderProps) {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const pathname = usePathname();

  // Sync theme from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("act-theme") as "dark" | "light" | null;
    const t = saved || "dark";
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("act-theme", next);
    // Update meta theme-color
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", next === "dark" ? "#0a0c12" : "#ffffff");
  }

  const isScanner = pathname === "/scanner";

  return (
    <header className="header">
      <div
        className="header-left"
        style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}
      >
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="logo-icon"
            src="/ACT-SHIELD.svg"
            alt="Albany County Crime Tracker logo"
            width={28}
            height={28}
          />
          <div className="header-title">
            <span className="header-name">Albany County</span>
            <span className="header-sub">Crime Tracker</span>
          </div>
        </Link>
        <div className="live-indicator">
          <span className="live-dot" />
          <span>Live</span>
        </div>
      </div>

      <div className="header-right">
        {!isScanner && onFilterOpen && (
          <button
            className="icon-btn"
            onClick={onFilterOpen}
            title="Filter feed"
            aria-label="Filter incidents"
          >
            <span className="material-icons">tune</span>
          </button>
        )}
        <button
          className="icon-btn"
          onClick={toggleTheme}
          title="Toggle theme"
          aria-label="Toggle light/dark mode"
        >
          <span className="material-icons">
            {theme === "dark" ? "light_mode" : "dark_mode"}
          </span>
        </button>
      </div>
    </header>
  );
}
