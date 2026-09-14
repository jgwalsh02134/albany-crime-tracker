export function isOfficialAgencySocial(outlet: string): boolean {
  return (
    /^Facebook · (?:Albany PD|Albany Fire|Colonie PD|Colonie EMS|Bethlehem PD|Cohoes PD|Cohoes Fire|Watervliet PD|Guilderland PD|Schenectady PD|Schenectady Fire|Rensselaer County Sheriff|East Greenbush Police|Guilderland Fire|Westmere Fire|Latham Fire|NYSP|Fuller Road VFD|Midway Fire|Shaker Road–Loudonville FD|Green Island Police|Menands Police|Rensselaer City Police)$/i.test(
      outlet,
    ) ||
    /^X · (?:NYSP|Troy PD|Schdy Police|Cohoes Fire|Guilderland PD|Bethlehem PD|Albany Fire|Albany County Sheriff|Albany Police|Colonie Police|Thruway TRANSalert)$/i.test(
      outlet,
    )
  );
}

