/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, vi } from 'vitest';
import {
    type AsyncEvent,
    AsyncEventEmitter,
    type Disposable,
    disposeSafely,
    type Event,
    EventEmitter,
} from '../common/events';
import { createMock } from './test-utils';

describe('EventEmitter (synchronous)', () => {
    test('exposes an event property conforming to the Event<T> interface', () => {
        const emitter = new EventEmitter<string>();
        const event: Event<string> = emitter.event;
        const received: string[] = [];
        const sub = event((s) => received.push(s));
        emitter.fire('typed');
        expect(received).toEqual(['typed']);
        sub.dispose();
    });

    test('subscribes and delivers events to multiple listeners in registration order', () => {
        const emitter = new EventEmitter<string>();
        const order: string[] = [];

        emitter.event((data) => order.push(`A:${data}`));
        emitter.event((data) => order.push(`B:${data}`));
        emitter.event((data) => order.push(`C:${data}`));

        emitter.fire('payload');

        expect(order).toEqual(['A:payload', 'B:payload', 'C:payload']);
    });

    test('supports void / undefined payloads', () => {
        const emitter = new EventEmitter<void>();
        let callCount = 0;

        const sub = emitter.event(() => {
            callCount++;
        });

        emitter.fire();
        emitter.fire(undefined);
        expect(callCount).toBe(2);
        sub.dispose();
    });

    test('supports complex objects and arrays as event data', () => {
        interface ComplexEvent {
            id: number;
            items: string[];
            nested: { active: boolean };
        }
        const emitter = new EventEmitter<ComplexEvent>();
        const received: ComplexEvent[] = [];

        const sub = emitter.event((e) => received.push(e));

        const payload: ComplexEvent = {
            id: 42,
            items: ['foo', 'bar'],
            nested: { active: true },
        };
        emitter.fire(payload);

        expect(received).toHaveLength(1);
        expect(received[0]).toBe(payload);
        expect(received[0].nested.active).toBe(true);
        sub.dispose();
    });

    test('unsubscribing one listener leaves other listeners intact', () => {
        const emitter = new EventEmitter<number>();
        const receivedA: number[] = [];
        const receivedB: number[] = [];
        const receivedC: number[] = [];

        const subA = emitter.event((n) => receivedA.push(n));
        const subB = emitter.event((n) => receivedB.push(n));
        const subC = emitter.event((n) => receivedC.push(n));

        emitter.fire(1);

        subB.dispose();
        emitter.fire(2);

        subA.dispose();
        emitter.fire(3);

        expect(receivedA).toEqual([1, 2]);
        expect(receivedB).toEqual([1]);
        expect(receivedC).toEqual([1, 2, 3]);

        subC.dispose();
    });

    test('subscription dispose is idempotent', () => {
        const emitter = new EventEmitter<string>();
        const received: string[] = [];

        const sub = emitter.event((s) => received.push(s));

        sub.dispose();
        sub.dispose();
        sub.dispose();

        emitter.fire('test');
        expect(received).toEqual([]);
    });

    test('disposing one subscription multiple times when the same function is registered multiple times leaves subsequent subscriptions intact', () => {
        const emitter = new EventEmitter<string>();
        const received: string[] = [];
        const listener = (s: string) => received.push(s);

        const sub1 = emitter.event(listener);
        const sub2 = emitter.event(listener);

        emitter.fire('first');
        expect(received).toEqual(['first', 'first']);

        // Dispose sub1 multiple times
        sub1.dispose();
        sub1.dispose();
        sub1.dispose();

        received.length = 0;
        emitter.fire('second');
        // sub2 must still receive the event
        expect(received).toEqual(['second']);

        sub2.dispose();
        received.length = 0;
        emitter.fire('third');
        expect(received).toEqual([]);
    });

    test('supports thisArgs binding', () => {
        const emitter = new EventEmitter<number>();
        class Calculator {
            public value = 10;
            public add(amount: number) {
                this.value += amount;
            }
        }

        const calc = new Calculator();
        const sub = emitter.event(calc.add, calc);

        emitter.fire(5);
        expect(calc.value).toBe(15);
        sub.dispose();
    });

    test('appends created disposable to provided disposables array', () => {
        const emitter = new EventEmitter<string>();
        const disposables: Disposable[] = [];
        const received: string[] = [];

        emitter.event((s) => received.push(s), undefined, disposables);

        expect(disposables).toHaveLength(1);
        emitter.fire('before');
        expect(received).toEqual(['before']);

        disposables[0].dispose();
        emitter.fire('after');
        expect(received).toEqual(['before']);
    });

    test('handles listener unsubscribing itself during execution', () => {
        const emitter = new EventEmitter<number>();
        const received: number[] = [];
        let sub: Disposable | undefined;

        sub = emitter.event((num) => {
            received.push(num);
            if (num === 2) {
                sub?.dispose();
            }
        });

        emitter.fire(1);
        emitter.fire(2);
        emitter.fire(3);

        expect(received).toEqual([1, 2]);
    });

    test('handles listener unsubscribing another listener during execution (immediate suppression)', () => {
        const emitter = new EventEmitter<string>();
        const received: string[] = [];
        let subB: Disposable | undefined;

        emitter.event((msg) => {
            received.push(`A:${msg}`);
            subB?.dispose();
        });
        subB = emitter.event((msg) => {
            received.push(`B:${msg}`);
        });
        emitter.event((msg) => {
            received.push(`C:${msg}`);
        });

        emitter.fire('1');
        emitter.fire('2');

        // B is immediately suppressed on the first fire and remains unsubscribed on subsequent fires
        expect(received).toEqual(['A:1', 'C:1', 'A:2', 'C:2']);
        expect(received).not.toContain('B:1');
        expect(received).not.toContain('B:2');
    });

    test('handles listener adding a new listener during execution', () => {
        const emitter = new EventEmitter<string>();
        const received: string[] = [];

        emitter.event((msg) => {
            received.push(`Initial:${msg}`);
            if (msg === 'first') {
                emitter.event((innerMsg) => {
                    received.push(`Dynamic:${innerMsg}`);
                });
            }
        });

        emitter.fire('first');
        emitter.fire('second');

        expect(received).toEqual(['Initial:first', 'Initial:second', 'Dynamic:second']);
    });

    test('handles re-entrant recursive fire calls safely', () => {
        const emitter = new EventEmitter<number>();
        const depthLog: number[] = [];

        emitter.event((depth) => {
            depthLog.push(depth);
            if (depth > 0) {
                emitter.fire(depth - 1);
            }
        });

        emitter.fire(3);
        expect(depthLog).toEqual([3, 2, 1, 0]);
    });

    test('catches listener errors and continues calling remaining listeners', () => {
        const emitter = new EventEmitter<string>();
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const received: string[] = [];

        emitter.event(() => {
            throw new Error('Listener 1 failed');
        });
        emitter.event((msg) => {
            received.push(`Listener 2:${msg}`);
        });
        emitter.event(() => {
            throw new Error('Listener 3 failed');
        });
        emitter.event((msg) => {
            received.push(`Listener 4:${msg}`);
        });

        emitter.fire('test');

        expect(received).toEqual(['Listener 2:test', 'Listener 4:test']);
        expect(consoleSpy).toHaveBeenCalledTimes(2);
        consoleSpy.mockRestore();
    });

    test('firing with no listeners does not throw or error', () => {
        const emitter = new EventEmitter<string>();
        expect(() => emitter.fire('no-op')).not.toThrow();
    });

    test('emitter dispose clears all listeners and stops firing', () => {
        const emitter = new EventEmitter<string>();
        const received: string[] = [];

        emitter.event((s) => received.push(`A:${s}`));
        emitter.event((s) => received.push(`B:${s}`));

        emitter.fire('before');
        expect(received).toEqual(['A:before', 'B:before']);

        emitter.dispose();

        emitter.fire('after');
        expect(received).toEqual(['A:before', 'B:before']);
    });

    test('registering listeners on disposed emitter returns safe no-op disposable', () => {
        const emitter = new EventEmitter<string>();
        emitter.dispose();

        let called = false;
        const sub = emitter.event(() => {
            called = true;
        });

        emitter.fire('event');
        expect(called).toBe(false);
        expect(() => sub.dispose()).not.toThrow();
    });

    test('registering listeners on disposed emitter with disposables array appends disposable to array', () => {
        const emitter = new EventEmitter<string>();
        emitter.dispose();

        const disposables: Disposable[] = [];
        const sub = emitter.event(() => {}, undefined, disposables);

        expect(disposables).toHaveLength(1);
        expect(disposables[0]).toBe(sub);
        expect(() => disposables[0].dispose()).not.toThrow();
    });

    test('disposing emitter from inside a listener callback stops subsequent listeners from firing', () => {
        const emitter = new EventEmitter<string>();
        const received: string[] = [];

        emitter.event((s) => {
            received.push(`First:${s}`);
            emitter.dispose();
        });

        emitter.event((s) => {
            received.push(`Second:${s}`);
        });

        emitter.fire('payload');

        expect(received).toEqual(['First:payload']);
    });

    test('emitter dispose is idempotent', () => {
        const emitter = new EventEmitter<string>();
        expect(() => {
            emitter.dispose();
            emitter.dispose();
        }).not.toThrow();
    });
});

describe('AsyncEventEmitter (asynchronous)', () => {
    test('exposes an event property conforming to the AsyncEvent<T> interface', async () => {
        const emitter = new AsyncEventEmitter<string>();
        const event: AsyncEvent<string> = emitter.event;
        const disposables: Disposable[] = [];
        const received: string[] = [];

        class Target {
            public count = 0;
            public async onEvent(s: string) {
                await Promise.resolve();
                this.count++;
                received.push(`async:${s}:${this.count}`);
            }
            public onSyncEvent(s: string) {
                this.count++;
                received.push(`sync:${s}:${this.count}`);
            }
        }

        const target = new Target();
        // Test AsyncEvent with async listener, thisArgs, and disposables array
        event(target.onEvent, target, disposables);
        // Test AsyncEvent with sync listener, thisArgs, and disposables array
        event(target.onSyncEvent, target, disposables);

        expect(disposables).toHaveLength(2);

        await emitter.fire('first');
        expect(received).toEqual(['sync:first:1', 'async:first:2']);

        // Dispose via disposables array
        for (const d of disposables) {
            d.dispose();
        }

        await emitter.fire('second');
        expect(received).toEqual(['sync:first:1', 'async:first:2']);
    });

    test('subscribes and awaits multiple async listeners concurrently', async () => {
        const emitter = new AsyncEventEmitter<number>();
        const completionTimes: number[] = [];
        const startTime = Date.now();

        emitter.event(async (val) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            completionTimes.push(val * 1);
        });
        emitter.event(async (val) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            completionTimes.push(val * 2);
        });

        await emitter.fire(5);

        // Since they run concurrently via Promise.all, listener 2 (10ms) finishes before listener 1 (20ms)
        expect(completionTimes).toEqual([10, 5]);
        expect(Date.now() - startTime).toBeGreaterThanOrEqual(15);
    });

    test('supports synchronous listeners inside AsyncEventEmitter', async () => {
        const emitter = new AsyncEventEmitter<string>();
        const received: string[] = [];

        emitter.event((data) => {
            received.push(`sync:${data}`);
        });
        emitter.event(async (data) => {
            await Promise.resolve();
            received.push(`async:${data}`);
        });

        await emitter.fire('payload');
        expect(received).toEqual(['sync:payload', 'async:payload']);
    });

    test('unsubscribing async listener prevents future invocations', async () => {
        const emitter = new AsyncEventEmitter<string>();
        const received: string[] = [];

        const subA = emitter.event(async (data) => {
            received.push(`A:${data}`);
        });
        const subB = emitter.event(async (data) => {
            received.push(`B:${data}`);
        });

        await emitter.fire('first');
        subA.dispose();

        await emitter.fire('second');
        expect(received).toEqual(['A:first', 'B:first', 'B:second']);
        subB.dispose();
    });

    test('handles listener unsubscribing another listener during execution (immediate suppression) on AsyncEventEmitter', async () => {
        const emitter = new AsyncEventEmitter<string>();
        const received: string[] = [];
        let subB: Disposable | undefined;

        emitter.event(async (msg) => {
            received.push(`A:${msg}`);
            subB?.dispose();
        });
        subB = emitter.event(async (msg) => {
            received.push(`B:${msg}`);
        });
        emitter.event(async (msg) => {
            received.push(`C:${msg}`);
        });

        await emitter.fire('1');
        await emitter.fire('2');

        expect(received).toEqual(['A:1', 'C:1', 'A:2', 'C:2']);
        expect(received).not.toContain('B:1');
        expect(received).not.toContain('B:2');
    });

    test('subscription dispose is idempotent on AsyncEventEmitter', async () => {
        const emitter = new AsyncEventEmitter<string>();
        const received: string[] = [];

        const sub = emitter.event(async (s) => {
            received.push(s);
        });

        sub.dispose();
        sub.dispose();

        await emitter.fire('test');
        expect(received).toEqual([]);
    });

    test('disposing one subscription multiple times when the same function is registered multiple times leaves subsequent subscriptions intact on AsyncEventEmitter', async () => {
        const emitter = new AsyncEventEmitter<string>();
        const received: string[] = [];
        const listener = async (s: string) => {
            received.push(s);
        };

        const sub1 = emitter.event(listener);
        const sub2 = emitter.event(listener);

        await emitter.fire('first');
        expect(received).toEqual(['first', 'first']);

        // Dispose sub1 multiple times
        sub1.dispose();
        sub1.dispose();
        sub1.dispose();

        received.length = 0;
        await emitter.fire('second');
        // sub2 must still receive the event
        expect(received).toEqual(['second']);

        sub2.dispose();
        received.length = 0;
        await emitter.fire('third');
        expect(received).toEqual([]);
    });

    test('supports thisArgs binding on AsyncEventEmitter', async () => {
        const emitter = new AsyncEventEmitter<number>();
        class AsyncCalculator {
            public value = 10;
            public async add(amount: number) {
                await Promise.resolve();
                this.value += amount;
            }
        }

        const calc = new AsyncCalculator();
        const sub = emitter.event(calc.add, calc);

        await emitter.fire(5);
        expect(calc.value).toBe(15);
        sub.dispose();
    });

    test('appends created disposable to provided disposables array on AsyncEventEmitter', async () => {
        const emitter = new AsyncEventEmitter<string>();
        const disposables: Disposable[] = [];
        const received: string[] = [];

        emitter.event(
            async (s) => {
                received.push(s);
            },
            undefined,
            disposables,
        );

        expect(disposables).toHaveLength(1);
        await emitter.fire('before');
        expect(received).toEqual(['before']);

        disposables[0].dispose();
        await emitter.fire('after');
        expect(received).toEqual(['before']);
    });

    test('handles multiple async listeners rejecting safely without unhandled errors', async () => {
        const emitter = new AsyncEventEmitter<string>();
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const completed: string[] = [];

        emitter.event(async () => {
            throw new Error('Sync throw in async handler');
        });
        emitter.event(async (msg) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            completed.push(`Success:${msg}`);
        });
        emitter.event(async () => {
            await new Promise((_, reject) => setTimeout(() => reject(new Error('Async rejection')), 5));
        });

        await emitter.fire('event');

        expect(completed).toEqual(['Success:event']);
        expect(consoleSpy).toHaveBeenCalledTimes(2);
        consoleSpy.mockRestore();
    });

    test('firing with no async listeners resolves immediately', async () => {
        const emitter = new AsyncEventEmitter<string>();
        await expect(emitter.fire('no-op')).resolves.toBeUndefined();
    });

    test('AsyncEventEmitter dispose prevents future fires and handles in-flight events', async () => {
        const emitter = new AsyncEventEmitter<string>();
        const received: string[] = [];

        emitter.event(async (s) => {
            received.push(s);
        });

        await emitter.fire('before');
        expect(received).toEqual(['before']);

        emitter.dispose();

        await emitter.fire('after');
        expect(received).toEqual(['before']);
    });

    test('registering listeners on disposed AsyncEventEmitter returns safe no-op disposable', async () => {
        const emitter = new AsyncEventEmitter<string>();
        emitter.dispose();

        let called = false;
        const sub = emitter.event(async () => {
            called = true;
        });

        await emitter.fire('event');
        expect(called).toBe(false);
        expect(() => sub.dispose()).not.toThrow();
    });

    test('registering listeners on disposed AsyncEventEmitter with disposables array appends disposable to array', () => {
        const emitter = new AsyncEventEmitter<string>();
        emitter.dispose();

        const disposables: Disposable[] = [];
        const sub = emitter.event(async () => {}, undefined, disposables);

        expect(disposables).toHaveLength(1);
        expect(disposables[0]).toBe(sub);
        expect(() => disposables[0].dispose()).not.toThrow();
    });

    test('AsyncEventEmitter dispose is idempotent', () => {
        const emitter = new AsyncEventEmitter<string>();
        expect(() => {
            emitter.dispose();
            emitter.dispose();
        }).not.toThrow();
    });
});

describe('disposeSafely', () => {
    test('calls dispose on valid disposable', () => {
        let disposed = false;
        const d: Disposable = {
            dispose: () => {
                disposed = true;
            },
        };
        disposeSafely(d);
        expect(disposed).toBe(true);
    });

    test('handles undefined disposable without throwing', () => {
        expect(() => disposeSafely(undefined)).not.toThrow();
    });

    test('catches error and forwards to onError callback', () => {
        const error = new Error('Dispose failed');
        const d: Disposable = {
            dispose: () => {
                throw error;
            },
        };
        const errors: unknown[] = [];
        disposeSafely(d, (err) => errors.push(err));
        expect(errors).toEqual([error]);
    });

    test('catches error without throwing if no onError callback is provided', () => {
        const d: Disposable = {
            dispose: () => {
                throw new Error('Silent failure');
            },
        };
        expect(() => disposeSafely(d)).not.toThrow();
    });

    test('handles malformed objects without a dispose function without throwing', () => {
        const malformed = createMock<Disposable>({});
        expect(() => disposeSafely(malformed)).not.toThrow();
    });
});
