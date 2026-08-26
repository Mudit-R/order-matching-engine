package com.engine.ringbuffer;

import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;

/**
 * Cache-padded Lock-Free SPSC Ring Buffer in Java 22.
 * Uses atomic acquire-release semantics to avoid mutex contention.
 */
public class LockFreeRingBuffer<T> {
    private final int capacity;
    private final int mask;
    private final Object[] buffer;

    // Cache-line padding before tail
    protected long p1, p2, p3, p4, p5, p6, p7;
    private volatile long tail = 0;
    private long headCached = 0;
    protected long p8, p9, p10, p11, p12, p13, p14;

    private volatile long head = 0;
    private long tailCached = 0;
    protected long p15, p16, p17, p18, p19, p20, p21;

    private static final VarHandle TAIL_VH;
    private static final VarHandle HEAD_VH;

    static {
        try {
            MethodHandles.Lookup l = MethodHandles.lookup();
            TAIL_VH = l.findVarHandle(LockFreeRingBuffer.class, "tail", long.class);
            HEAD_VH = l.findVarHandle(LockFreeRingBuffer.class, "head", long.class);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    public LockFreeRingBuffer(int capacity) {
        if (Integer.bitCount(capacity) != 1) {
            throw new IllegalArgumentException("Capacity must be a power of 2");
        }
        this.capacity = capacity;
        this.mask = capacity - 1;
        this.buffer = new Object[capacity];
    }

    public boolean push(T item) {
        long currentTail = (long) TAIL_VH.get(this);
        long currentHead = headCached;

        if (currentTail - currentHead >= capacity) {
            headCached = (long) HEAD_VH.getAcquire(this);
            if (currentTail - headCached >= capacity) {
                return false; // Full
            }
        }

        buffer[(int) (currentTail & mask)] = item;
        TAIL_VH.setRelease(this, currentTail + 1);
        return true;
    }

    @SuppressWarnings("unchecked")
    public T pop() {
        long currentHead = (long) HEAD_VH.get(this);
        long currentTail = tailCached;

        if (currentHead == currentTail) {
            tailCached = (long) TAIL_VH.getAcquire(this);
            if (currentHead == tailCached) {
                return null; // Empty
            }
        }

        int index = (int) (currentHead & mask);
        T item = (T) buffer[index];
        buffer[index] = null; // Help GC
        HEAD_VH.setRelease(this, currentHead + 1);
        return item;
    }

    public boolean isEmpty() {
        return (long) HEAD_VH.get(this) == (long) TAIL_VH.get(this);
    }
}
