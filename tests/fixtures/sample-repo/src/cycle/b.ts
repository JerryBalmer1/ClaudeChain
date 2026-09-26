import { a } from './a.js';

export function b(n: number): number {
  return n <= 0 ? 0 : a(n - 1);
}
