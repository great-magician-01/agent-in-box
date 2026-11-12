package guestagent

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestActionTrackerReserveIsConcurrentSafe(t *testing.T) {
	tracker := newActionTracker(func() time.Time { return time.Unix(0, 0) })
	var wg sync.WaitGroup
	start := make(chan struct{})
	for index := 0; index < 64; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			if !tracker.reserve(fmt.Sprintf("action-%d", index)) {
				t.Errorf("unique action %d was rejected", index)
			}
		}(index)
	}
	close(start)
	wg.Wait()

	if tracker.reserve("action-0") {
		t.Fatal("retained action id was accepted twice")
	}
}
