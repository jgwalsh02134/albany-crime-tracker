import dcjs from "@/data/dcjs-albany.json";

/** Map directory agency ids to NYS DCJS Index Crime agency names (2024 file). */
export const DCJS_NAME_BY_ID: Record<string, string> = {
  "albany-pd": "Albany City PD",
  "colonie-pd": "Colonie Town PD",
  "guilderland-pd": "Guilderland Town PD",
  "bethlehem-pd": "Bethlehem Town PD",
  "watervliet-pd": "Watervliet City PD",
  "cohoes-pd": "Cohoes City PD",
  "nysp-troop-g": "Albany County State Police",
  "ualbany-upd": "SUNY Police - Albany",
  "menands-pd": "Menands Vg PD",
  "albany-county-sheriff": "Albany County Sheriff",
  "coeymans-pd": "Coeymans Town PD",
  "altamont-pd": "Altamont Vg PD",
};

export type DcjsRow = (typeof dcjs.agencies)[number];

export function dcjsFor(agencyId: string): DcjsRow | undefined {
  const name = DCJS_NAME_BY_ID[agencyId];
  if (!name) return undefined;
  return dcjs.agencies.find((a) => a.agency === name);
}
