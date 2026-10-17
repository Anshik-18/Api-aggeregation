export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class TestClock implements Clock {
  private currentTime: number;

  constructor(initialTime = 1700000000000) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  advance(ms: number): void {
    this.currentTime += ms;
  }

  set(time: number): void {
    this.currentTime = time;
  }
}
