import { greet } from './greet.js';
import { Store } from './store.js';
import * as ops from './math/ops.js';

export { greet } from './greet.js';
export * from './math/index.js';

export function main(): number {
  const store = new Store();
  store.add(greet('world'));
  report(store);
  return ops.double(2);
}

function report(store: Store): void {
  console.log(store.size());
}
