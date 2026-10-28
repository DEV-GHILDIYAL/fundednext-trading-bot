/** Prop-challenge pass probability from a strategy's own trade results (R multiples) */
/** Block bootstrap of the R series (keeps losing streaks together): P(reach target before max loss) */
export function monteCarloPass(rs: number[], targetR: number, maxLossR: number, sims: number = 20000, block: number = 5, maxTrades: number = 1000, seed: number = 42) {
  if (rs.length === 0) return { pass: 0, medianTrades: Infinity };
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  let passes = 0;
  const lens: number[] = [];
  for (let s = 0; s < sims; s++) {
    let eq = 0;
    let n = 0;
    let done = false;
    while (!done && n < maxTrades) {
      const start = Math.floor(rand() * rs.length);
      for (let k = 0; k < block && n < maxTrades; k++) {
        eq += rs[(start + k) % rs.length];
        n++;
        if (eq >= targetR) {
          passes++;
          lens.push(n);
          done = true;
          break;
        }
        if (eq <= -maxLossR) {
          done = true;
          break;
        }
      }
    }
  }
  lens.sort((a, b) => a - b);
  return { pass: passes / sims, medianTrades: lens.length ? lens[Math.floor(lens.length / 2)] : Infinity };
}
