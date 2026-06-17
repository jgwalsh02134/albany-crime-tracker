"use client";

/**
 * HomeShell — client component that wraps the home page layout.
 * Manages filter state and passes it down to LiveFeed.
 */

import { useState } from "react";
import type { Incident } from "../types";
import Header from "./Header";
import BottomNav from "./BottomNav";
import LiveFeed, { type LiveFeedFilters } from "./LiveFeed";
import CriticalFilter from "./CriticalFilter";

const ALL_SEVERITIES = ["critical", "high", "medium", "low"];
const ALL_MUNICIPALITIES = [
  "Albany", "Colonie", "Bethlehem", "Guilderland", "Cohoes", "Watervliet",
  "Green Island", "Menands", "Coeymans", "New Scotland", "Berne", "Knox",
  "Westerlo", "Rensselaerville",
];

interface HomeShellProps {
  initialIncidents: Incident[];
}

export default function HomeShell({ initialIncidents }: HomeShellProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [filters, setFilters] = useState<LiveFeedFilters>({
    severities: ALL_SEVERITIES,
    municipalities: ALL_MUNICIPALITIES,
  });

  return (
    <>
      <Header onFilterOpen={() => setFilterOpen(true)} />

      {/* Sub-header: Live tab indicator */}
      <div className="home-sub-header">
        <div className="home-mode-bar" role="tablist" aria-label="Home mode">
          <button
            className="home-mode-btn active"
            role="tab"
            aria-selected="true"
          >
            Live
          </button>
        </div>
      </div>

      {/* Main feed */}
      <main className="main-content">
        <LiveFeed
          initialIncidents={initialIncidents}
          filters={filters}
        />
      </main>

      {/* Filter sheet */}
      <CriticalFilter
        isOpen={filterOpen}
        onClose={() => setFilterOpen(false)}
        onApply={(f) =>
          setFilters({
            severities: f.severities,
            municipalities: f.municipalities,
          })
        }
        initialFilters={filters}
      />

      <BottomNav />
    </>
  );
}
