import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money parsing', () => {
  test('parses decimal strings and always serialises with scale 2', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25.5').toJSON().amount).toBe('25.50');
    expect(brl('25.05').toJSON().amount).toBe('25.05');
    expect(brl('0.00').toJSON().amount).toBe('0.00');
    expect(brl('0').isZero()).toBe(true);
  });

  test('handles the largest supported value exactly', () => {
    expect(brl('99999999999999999.99').toJSON().amount).toBe('99999999999999999.99');
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E3'],
    ['0x10'],
    [''],
    [' '],
    ['12.345'],
    ['25.001'],
    ['-1.00'],
    ['+1.00'],
    ['1,00'],
    ['.5'],
    ['5.'],
    ['1_000'],
    ['100000000000000000.00'],
  ])('rejects invalid amount %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects a JS number for amount (money is never a number)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each([[''], ['brl'], ['BR'], ['BRLX'], ['12A']])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('rejects non-object input', () => {
    expect(() => Money.from(null as never)).toThrow(InvalidMoneyError);
    expect(() => Money.from('1.00' as never)).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic (exact, immutable)', () => {
  test('avoids the float traps', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('1.10').add(brl('2.20')).toJSON().amount).toBe('3.30');
    expect(brl('0.30').subtract(brl('0.10')).toJSON().amount).toBe('0.20');
  });

  test('every operation returns a new instance and leaves the operands untouched', () => {
    const a = brl('10.00');
    const b = brl('2.50');
    const sum = a.add(b);
    const diff = a.subtract(b);
    const neg = a.negate();
    expect(sum).not.toBe(a);
    expect(diff).not.toBe(a);
    expect(neg).not.toBe(a);
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('2.50');
  });

  test('subtraction may go negative (needed by reconciliation) and serialises with a sign', () => {
    const diff = brl('1.00').subtract(brl('3.50'));
    expect(diff.isNegative()).toBe(true);
    expect(diff.toJSON().amount).toBe('-2.50');
    expect(diff.negate().toJSON().amount).toBe('2.50');
  });

  test('predicates', () => {
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('1.00').negate().isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
  });

  test('equals compares value and currency, and never throws', () => {
    expect(brl('5.00').equals(brl('5'))).toBe(true);
    expect(brl('5.00').equals(brl('5.01'))).toBe(false);
    expect(brl('5.00').equals(Money.from({ amount: '5.00', currency: 'USD' }))).toBe(false);
  });

  test('zero(currency)', () => {
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
  });

  test('toString', () => {
    expect(brl('7').toString()).toBe('7.00 BRL');
  });

  test('overflowing the supported range is rejected', () => {
    expect(() => brl('99999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
  });
});

describe('Money currency conflicts', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test('add, subtract and isLessThan across currencies throw a domain error', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});
