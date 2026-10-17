/**
 * Fixed-precision monetary utilities.
 * All internal financial amounts are represented as 64-bit BigInt micro-units (microdollars):
 * $1.000000 USD = 1,000,000 micros.
 * Eliminates JavaScript floating-point rounding errors entirely.
 */
export class Money {
  public static readonly MICRO_FACTOR = 1_000_000n;

  /**
   * Converts a decimal dollar number or string to BigInt micros.
   * e.g. 0.001 -> 1000n, "12.50" -> 12500000n
   */
  public static toMicros(dollars: number | string): bigint {
    const str = typeof dollars === 'number' ? dollars.toFixed(6) : dollars.trim();
    const parts = str.split('.');
    const whole = BigInt(parts[0] || '0');
    let fractionalStr = (parts[1] || '').padEnd(6, '0').slice(0, 6);
    const fractional = BigInt(fractionalStr);

    if (whole < 0n) {
      return whole * this.MICRO_FACTOR - fractional;
    }
    return whole * this.MICRO_FACTOR + fractional;
  }

  /**
   * Converts BigInt micros to formatted dollar string with 6 decimal places.
   * e.g. 1000n -> "0.001000"
   */
  public static toDollars(micros: bigint): string {
    const isNegative = micros < 0n;
    const abs = isNegative ? -micros : micros;
    const whole = abs / this.MICRO_FACTOR;
    const fractional = abs % this.MICRO_FACTOR;
    const fracStr = fractional.toString().padStart(6, '0');
    return `${isNegative ? '-' : ''}${whole}.${fracStr}`;
  }

  /**
   * Converts BigInt micros to standard 2-decimal display (e.g. for user balance).
   */
  public static toDisplayDollars(micros: bigint): string {
    const isNegative = micros < 0n;
    const abs = isNegative ? -micros : micros;
    const cents = (abs + 5000n) / 10000n; // Round to nearest cent
    const whole = cents / 100n;
    const frac = cents % 100n;
    return `${isNegative ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`;
  }
}
