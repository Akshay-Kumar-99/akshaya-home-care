import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { PASSWORD_MIN_LENGTH, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '../../shared/constants.ts';

// Argon2id (the library default algorithm) with OWASP's baseline parameters:
// 19 MiB memory, 2 iterations, 1 lane.
const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  return verify(storedHash, password);
}

/**
 * PINs are short, so they also get a server-side pepper, passed as Argon2's secret key.
 * A stolen database without the pepper (held only in the host's env vars) cannot be brute-forced offline.
 */
export async function hashPin(pin: string, pepper: Uint8Array): Promise<string> {
  return hash(pin, { ...ARGON2_PARAMS, secret: pepper });
}

export async function verifyPin(storedHash: string, pin: string, pepper: Uint8Array): Promise<boolean> {
  return verify(storedHash, pin, { secret: pepper });
}

/** Decodes the base64 PIN_PEPPER env var; requires at least 32 bytes. */
export function parsePepper(base64: string | undefined): Uint8Array {
  if (!base64) throw new Error('PIN_PEPPER is not set');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 32) throw new Error('PIN_PEPPER must decode to at least 32 bytes');
  return new Uint8Array(bytes);
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

export function isValidPassword(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= 256;
}

// No 0/O/1/l/I, so printed credentials are hard to misread.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SUFFIX_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomString(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** CSPRNG password; 18 chars from a 56-symbol alphabet ≈ 104 bits. */
export function generatePassword(length = 18): string {
  if (length < 16) throw new RangeError('generated passwords must be at least 16 characters');
  return randomString(PASSWORD_ALPHABET, length);
}

export function generatePin(length = PIN_MIN_LENGTH): string {
  if (length < PIN_MIN_LENGTH) throw new RangeError(`PIN must be at least ${PIN_MIN_LENGTH} digits`);
  let pin = '';
  for (let i = 0; i < length; i++) pin += randomInt(10).toString();
  return pin;
}

export function generateUsername(prefix: string): string {
  return `${prefix}-${randomString(SUFFIX_ALPHABET, 4)}`;
}
