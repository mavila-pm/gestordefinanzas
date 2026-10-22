/** "1 movimiento" / "3 movimientos": counts read as Spanish, never "movimiento(s)". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
