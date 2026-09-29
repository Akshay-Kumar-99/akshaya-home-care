import { describe, expect, it } from 'vitest';
import {
  generatePassword,
  generatePin,
  generateUsername,
  hashPassword,
  hashPin,
  isValidPin,
  parsePepper,
  verifyPassword,
  verifyPin,
} from '../../src/server/auth/hashing.ts';
import { normalizeConnectionString } from '../../src/server/db/client.ts';
import { pickCounterStart } from '../../src/server/db/seed.ts';

describe('(e) invoice counter start selection', () => {
  it('asks the CSPRNG for exactly [10000, 90000), i.e. 10000–89999 inclusive', () => {
    const calls: Array<[number, number]> = [];
    pickCounterStart((min, max) => {
      calls.push([min, max]);
      return min;
    });
    expect(calls).toEqual([[10000, 90000]]);
  });

  it('accepts both inclusive bounds and refuses anything outside', () => {
    expect(pickCounterStart(() => 10000)).toBe(10000);
    expect(pickCounterStart(() => 89999)).toBe(89999);
    expect(() => pickCounterStart(() => 9999)).toThrow();
    expect(() => pickCounterStart(() => 90000)).toThrow();
    expect(() => pickCounterStart(() => 12345.5)).toThrow();
  });

  it('never leaves the range over many real draws', () => {
    for (let i = 0; i < 20000; i++) {
      const v = pickCounterStart();
      expect(v >= 10000 && v <= 89999).toBe(true);
    }
  });
});

describe('credential generation', () => {
  it('generates 6-digit PINs and refuses shorter ones', () => {
    for (let i = 0; i < 100; i++) expect(generatePin()).toMatch(/^\d{6}$/);
    expect(() => generatePin(4)).toThrow();
    expect(isValidPin('12345')).toBe(false);
    expect(isValidPin('123456')).toBe(true);
    expect(isValidPin('12345a')).toBe(false);
  });

  it('generates long passwords and prefixed usernames', () => {
    expect(generatePassword().length).toBeGreaterThanOrEqual(16);
    expect(() => generatePassword(12)).toThrow();
    expect(generateUsername('tech')).toMatch(/^tech-[a-z0-9]{4}$/);
    expect(new Set(Array.from({ length: 50 }, () => generatePassword())).size).toBe(50);
  });
});

describe('Argon2id hashing', () => {
  const pepper = new Uint8Array(32).fill(3);

  it('hashes passwords with Argon2id and verifies them', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(h).toContain('m=19456,t=2,p=1');
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });

  it('peppers PINs: the right PIN fails without the right pepper', async () => {
    const h = await hashPin('482913', pepper);
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPin(h, '482913', pepper)).toBe(true);
    expect(await verifyPin(h, '482914', pepper)).toBe(false);
    expect(await verifyPin(h, '482913', new Uint8Array(32).fill(4))).toBe(false);
  });

  it('requires a pepper of at least 32 bytes', () => {
    expect(() => parsePepper(undefined)).toThrow();
    expect(() => parsePepper(Buffer.alloc(16).toString('base64'))).toThrow();
    expect(parsePepper(Buffer.alloc(32, 1).toString('base64')).length).toBe(32);
  });
});

describe('connection string normalisation', () => {
  it('pins sslmode=verify-full', () => {
    const out = new URL(normalizeConnectionString('postgresql://u:p@host.example/db?sslmode=require'));
    expect(out.searchParams.get('sslmode')).toBe('verify-full');
    const none = new URL(normalizeConnectionString('postgresql://u:p@host.example/db'));
    expect(none.searchParams.get('sslmode')).toBe('verify-full');
  });
});
