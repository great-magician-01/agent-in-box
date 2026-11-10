package vmprovider

import "sync"

// keyedMutex serializes operations for the same VM while allowing different
// VMs to proceed concurrently. Entries are released once no waiter remains, so
// a long-lived supervisor does not accumulate locks for deleted VMs.
type keyedMutex struct {
	mu      sync.Mutex
	entries map[string]*keyedMutexEntry
}

type keyedMutexEntry struct {
	mu   sync.Mutex
	refs int
}

// Lock blocks until the key is exclusively held and returns the matching
// unlock function. Callers must call the returned function exactly once.
func (k *keyedMutex) Lock(key string) func() {
	k.mu.Lock()
	if k.entries == nil {
		k.entries = make(map[string]*keyedMutexEntry)
	}
	entry := k.entries[key]
	if entry == nil {
		entry = &keyedMutexEntry{}
		k.entries[key] = entry
	}
	entry.refs++
	k.mu.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		k.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(k.entries, key)
		}
		k.mu.Unlock()
	}
}
