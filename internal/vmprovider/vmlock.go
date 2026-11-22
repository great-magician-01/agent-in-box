package vmprovider

import (
	"context"
	"sync"
)

// keyedMutex serializes operations for the same VM while allowing different
// VMs to proceed concurrently. Waiting is cancellable so a stalled lifecycle
// operation cannot hold up shutdown or a newer request forever.
type keyedMutex struct {
	mu      sync.Mutex
	entries map[string]*keyedMutexEntry
}

type keyedMutexEntry struct {
	sem  chan struct{}
	refs int
}

// Lock waits for exclusive ownership of key or for ctx to be cancelled. The
// returned function must be called exactly once after a successful lock.
func (k *keyedMutex) Lock(ctx context.Context, key string) (func(), error) {
	k.mu.Lock()
	if k.entries == nil {
		k.entries = make(map[string]*keyedMutexEntry)
	}
	entry := k.entries[key]
	if entry == nil {
		entry = &keyedMutexEntry{sem: make(chan struct{}, 1)}
		k.entries[key] = entry
	}
	entry.refs++
	k.mu.Unlock()

	select {
	case entry.sem <- struct{}{}:
		return func() {
			<-entry.sem
			k.mu.Lock()
			entry.refs--
			if entry.refs == 0 {
				delete(k.entries, key)
			}
			k.mu.Unlock()
		}, nil
	case <-ctx.Done():
		k.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(k.entries, key)
		}
		k.mu.Unlock()
		return nil, ctx.Err()
	}
}
