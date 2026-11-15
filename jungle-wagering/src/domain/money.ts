import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Wire/DTO representation: always a decimal string with scale 2. Never a JS number. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
/** Accepts "25", "25.5", "25.50". Rejects signs, NaN, Infinity, exponents, empty and >2 decimals. */
const INPUT_PATTERN = /^(\d{1,17})(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** numeric(19,2): 17 integer digits + 2 decimals. */
const MAX_MINOR_UNITS = 10n ** 19n - 1n;

/**
 * Immutable monetary value with exact arithmetic.
 * Stored as an integer count of minor units (bigint), so there is no float anywhere near money.
 * Does not depend on any ORM type or framework decorator.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Parses an inbound contract value. Negative amounts are rejected here; they can only arise from arithmetic. */
  static from(props: MoneyProps): Money {
    if (typeof props !== 'object' || props === null) {
      throw new InvalidMoneyError('money must be an object { amount, currency }');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string, never a number');
    }
    const match = INPUT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`invalid amount "${amount}": expected a non-negative decimal with at most ${SCALE} decimals`);
    }
    const integerPart = match[1] as string;
    const fraction = (match[2] ?? '').padEnd(SCALE, '0');
    return Money.ofMinorUnits(BigInt(integerPart) * FACTOR + BigInt(fraction), currency);
  }

  static zero(currency: string): Money {
    return Money.ofMinorUnits(0n, currency);
  }

  /** Internal/arithmetic constructor; allows negative values (e.g. reconciliation differences). */
  static ofMinorUnits(minor: bigint, currency: string): Money {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid currency "${String(currency)}": expected ISO-4217 alphabetic code`);
    }
    if (minor > MAX_MINOR_UNITS || minor < -MAX_MINOR_UNITS) {
      throw new InvalidMoneyError('amount out of supported range');
    }
    return new Money(minor, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return Money.ofMinorUnits(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  /** Same currency and same value. Different currencies are simply not equal (no throw). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toMinorUnits(): bigint {
    return this.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const integerPart = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integerPart.toString()}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
