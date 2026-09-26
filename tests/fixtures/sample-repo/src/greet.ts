import { upper } from './util/strings.js';

export function greet(name: string): string {
  return upper(`hello ${name}`);
}
