/** Los importes viajan en centavos enteros; solo se convierten a pesos al mostrarlos. */
const fmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const fmtCents = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 });

export function money(cents: number): string {
  return cents % 100 === 0 ? fmt.format(cents / 100) : fmtCents.format(cents / 100);
}

/** "+ $500" / "− $200" / "" para el sobreprecio de una opción. */
export function delta(cents: number): string {
  if (cents === 0) return '';
  return `${cents > 0 ? '+' : '−'} ${money(Math.abs(cents))}`;
}
