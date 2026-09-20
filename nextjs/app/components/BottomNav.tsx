"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Live", icon: "bolt", exact: true },
  { href: "/scanner", label: "Scanner", icon: "cell_tower", exact: false },
] as const;

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="tab-bar"
      role="tablist"
      aria-label="Main navigation"
    >
      {NAV_ITEMS.map((item) => {
        const isActive = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`tab-bar-item${isActive ? " active" : ""}`}
            role="tab"
            aria-selected={isActive}
            aria-label={item.label}
          >
            <span className="tab-bar-icon material-icons">{item.icon}</span>
            <span style={{ fontSize: 10, fontWeight: 500 }}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
