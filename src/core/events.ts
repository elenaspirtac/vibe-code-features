export class TypedEvent<T> {
  private listeners: ((data: T) => void)[] = [];

  add(listener: (data: T) => void): void {
    this.listeners.push(listener);
  }

  remove(listener: (data: T) => void): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) this.listeners.splice(idx, 1);
  }

  trigger(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }
}
