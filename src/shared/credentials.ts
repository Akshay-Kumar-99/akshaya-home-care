import { PASSWORD_MIN_LENGTH, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from './constants.ts';

// Credential rules shared by the server (authoritative) and the UI (instant feedback).

/** Repeats of a short block (000000, 121212, 123123) or straight runs (123456, 987654). */
export function isWeakPin(pin: string): boolean {
  for (const block of [1, 2, 3]) {
    if (pin.length % block === 0 && pin.length > block) {
      const unit = pin.slice(0, block);
      if (unit.repeat(pin.length / block) === pin) return true;
    }
  }
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]!);
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

export type PinProblem = 'pin_format' | 'pin_weak';
export type PasswordProblem = 'password_length' | 'password_contains_username' | 'password_repetitive';

export function checkNewPin(pin: string): PinProblem | null {
  if (!new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin)) return 'pin_format';
  if (isWeakPin(pin)) return 'pin_weak';
  return null;
}

export function checkNewPassword(password: string, username: string): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > 256) return 'password_length';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'password_contains_username';
  if (new Set(password).size < 4) return 'password_repetitive';
  return null;
}
