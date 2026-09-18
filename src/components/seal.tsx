import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Cache-bust when replacing public/seals assets. */
export const SEAL_VERSION = 98;

/**
 * Official circular seals that should fill the badge edge-to-edge.
 * Leftover patches, wordmarks, and media marks use the inset plate instead.
 */
const FILL_IDS = new Set([
  "albany-pd",
  "altamont-pd",
  "bethlehem-pd",
  "coeymans-pd",
  "cohoes-pd",
  "colonie-pd",
  "colonie-town",
  "cprb-albany",
  "green-island-pd",
  "guilderland-pd",
  "menands-pd",
  "albany-county-sheriff",
  "albany-county-probation",
  "albany-county-cvsvc",
  "albany-county-da",
  "albany-county-e911",
  "albany-county-stop-dwi",
  "dec-eco-region4",
  "nys-park-police",
  "nysp-troop-g",
  "nysp-troop-t",
  "siena-public-safety",
  "fbi-albany",
  "dea-albany",
  "atf-albany",
  "usms-ndny",
  "ice-hsi-albany",
  "uspis-albany",
  "irs-ci-albany",
  "cbp-albany",
  "usao-ndny",
  "fed-probation-ndny",
  "fps-region2",
  "ssa-oig",
  "va-police-albany",
  "nys-ag-cjd",
  "nys-dcjs",
  "nys-sla",
  "nys-omig",
  "nys-ig",
  "nys-dhses",
  "nys-court-officers",
  "nys-tax-ci",
  "nys-dfs",
  "nys-coelig",
  "nys-comptroller-investigations",
  "albany-med-security",
  "csx-railroad-police",
  "watervliet-pd",
  "ualbany-upd",
  "cdta-transit",
  "uha-public-safety",
  "albany-housing-authority",
  "amtrak-police",
  "usss-albany",
  "watervliet-arsenal",
  "nys-doccs",
]);

function initialsFrom(label: string): string {
  const cleaned = label
    .replace(/[—–]/g, " ")
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .trim();
  const words = cleaned.split(/\s+/).filter((w) => w && !/^(the|of|and|at|for|de|la)$/i.test(w));
  if (!words.length) return "—";
  if (words.length === 1) {
    const token = words[0];
    return token.length <= 4 ? token.toUpperCase() : token.slice(0, 3).toUpperCase();
  }
  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function Seal({
  id,
  label,
  className,
}: {
  id: string;
  label: string;
  className?: string;
}) {
  const [ok, setOk] = useState(true);
  const size = className ?? "size-11";
  const fill = FILL_IDS.has(id);

  useEffect(() => {
    setOk(true);
  }, [id]);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full shadow-sm ring-1 ring-black/10 dark:ring-white/15",
        fill ? "bg-white p-0" : "bg-white p-[13%] dark:bg-surface-2",
        size,
      )}
      title={label}
    >
      {ok ? (
        <img
          src={`/seals/${id}.png?v=${SEAL_VERSION}`}
          alt=""
          className={cn("size-full", fill ? "object-cover" : "object-contain")}
          decoding="async"
          loading="lazy"
          onError={() => setOk(false)}
        />
      ) : (
        <span
          className="flex size-full items-center justify-center rounded-full bg-surface-2 text-[0.62em] font-bold leading-none tracking-wide text-muted"
          aria-hidden
        >
          {initialsFrom(label)}
        </span>
      )}
    </span>
  );
}
