import { randomBytes } from 'node:crypto';

// Usage: npm run gen:secret
// Prints a 32-byte random value (base64) for PIN_PEPPER. Use a DIFFERENT value per
// environment (dev, test, production). Changing it later invalidates every stored PIN.
console.log(randomBytes(32).toString('base64'));
