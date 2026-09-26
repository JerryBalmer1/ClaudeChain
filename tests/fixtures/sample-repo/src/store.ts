import type { Item } from './types.js';
import { EventEmitter } from 'node:events';

export class Store extends EventEmitter {
  private readonly items: Item[] = [];

  public add(label: string): void {
    this.items.push({ id: String(this.items.length), label });
    this.notify();
  }

  public size(): number {
    return this.items.length;
  }

  private notify(): void {
    this.emit('change');
  }

  public static create(): Store {
    return new Store();
  }
}
