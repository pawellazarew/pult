//! Daemon-owned operations that must finish before its ownership lease releases.
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

#[derive(Default)]
pub(crate) struct Tracker {
    active: AtomicUsize,
    changed: Notify,
    #[cfg(test)]
    pub(crate) draining: Notify,
}

pub(crate) struct Guard(Arc<Tracker>);

impl Tracker {
    pub(crate) fn track(self: &Arc<Self>) -> Guard {
        self.active.fetch_add(1, Ordering::AcqRel);
        Guard(self.clone())
    }

    /// Admission is sealed and client tasks joined before this drain begins.
    pub(crate) async fn wait(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            #[cfg(test)]
            self.draining.notify_one();
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            changed.await;
        }
    }

    #[cfg(test)]
    pub(crate) fn active(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.changed.notify_waiters();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::{Context, Poll, Waker};

    #[tokio::test]
    async fn wait_observes_last_guard_and_returns_immediately_at_zero() {
        let tracker = Arc::new(Tracker::default());
        tracker.wait().await;
        let first = tracker.track();
        let second = tracker.track();
        let mut waiting = Box::pin(tracker.wait());
        let mut context = Context::from_waker(Waker::noop());
        assert!(waiting.as_mut().poll(&mut context).is_pending());
        drop(first);
        assert_eq!(tracker.active(), 1);
        assert!(waiting.as_mut().poll(&mut context).is_pending());
        drop(second);
        assert_eq!(waiting.as_mut().poll(&mut context), Poll::Ready(()));
    }

    #[tokio::test]
    async fn aborting_unpolled_task_releases_its_moved_guard() {
        let tracker = Arc::new(Tracker::default());
        let guard = tracker.track();
        let task = tokio::spawn(async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        });
        assert_eq!(tracker.active(), 1);
        task.abort();
        let _ = task.await;
        tracker.wait().await;
        assert_eq!(tracker.active(), 0);
    }

    #[tokio::test]
    async fn last_guard_wakes_an_armed_drain_waiter() {
        let tracker = Arc::new(Tracker::default());
        let guard = tracker.track();
        let waiting = tracker.clone();
        let task = tokio::spawn(async move { waiting.wait().await });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tracker.draining.notified(),
        )
        .await
        .unwrap();
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }
}
