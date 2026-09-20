"use client";

import { useState, useCallback } from "react";

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const MUNICIPALITIES = [
  "Albany",
  "Colonie",
  "Bethlehem",
  "Guilderland",
  "Cohoes",
  "Watervliet",
  "Green Island",
  "Menands",
  "Coeymans",
  "New Scotland",
  "Berne",
  "Knox",
  "Westerlo",
  "Rensselaerville",
] as const;

export interface FilterValues {
  severities: string[];
  municipalities: string[];
}

interface CriticalFilterProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (filters: FilterValues) => void;
  initialFilters?: FilterValues;
}

export default function CriticalFilter({
  isOpen,
  onClose,
  onApply,
  initialFilters,
}: CriticalFilterProps) {
  const [severities, setSeverities] = useState<string[]>(
    initialFilters?.severities ?? [...SEVERITIES]
  );
  const [municipalities, setMunicipalities] = useState<string[]>(
    initialFilters?.municipalities ?? [...MUNICIPALITIES]
  );

  const toggleSeverity = useCallback((sev: string) => {
    setSeverities((prev) =>
      prev.includes(sev) ? prev.filter((s) => s !== sev) : [...prev, sev]
    );
  }, []);

  const toggleMuni = useCallback((muni: string) => {
    setMunicipalities((prev) =>
      prev.includes(muni) ? prev.filter((m) => m !== muni) : [...prev, muni]
    );
  }, []);

  const handleReset = useCallback(() => {
    setSeverities([...SEVERITIES]);
    setMunicipalities([...MUNICIPALITIES]);
  }, []);

  const handleApply = useCallback(() => {
    onApply({ severities, municipalities });
    onClose();
  }, [severities, municipalities, onApply, onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`filter-sheet-backdrop${isOpen ? " open" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        className={`filter-sheet${isOpen ? " open" : ""}`}
        aria-label="Filter incidents"
        role="dialog"
        aria-modal="true"
      >
        <div className="filter-sheet-handle" />
        <h3 className="filter-sheet-title">Filter Incidents</h3>

        {/* Severity */}
        <div className="filter-sheet-section">
          <h4 className="filter-sheet-label">Severity</h4>
          <div className="filter-sheet-options">
            {SEVERITIES.map((sev) => (
              <label key={sev} className="filter-sheet-check">
                <input
                  type="checkbox"
                  checked={severities.includes(sev)}
                  onChange={() => toggleSeverity(sev)}
                />
                {sev.charAt(0).toUpperCase() + sev.slice(1)}
              </label>
            ))}
          </div>
        </div>

        {/* Municipality */}
        <div className="filter-sheet-section">
          <h4 className="filter-sheet-label">Municipality</h4>
          <div className="filter-sheet-options">
            {MUNICIPALITIES.map((muni) => (
              <label key={muni} className="filter-sheet-check">
                <input
                  type="checkbox"
                  checked={municipalities.includes(muni)}
                  onChange={() => toggleMuni(muni)}
                />
                {muni}
              </label>
            ))}
          </div>
        </div>

        <div className="filter-sheet-actions">
          <button
            type="button"
            className="filter-sheet-btn filter-sheet-btn--reset"
            onClick={handleReset}
          >
            Reset All
          </button>
          <button
            type="button"
            className="filter-sheet-btn filter-sheet-btn--apply"
            onClick={handleApply}
          >
            Apply
          </button>
        </div>
      </div>
    </>
  );
}
