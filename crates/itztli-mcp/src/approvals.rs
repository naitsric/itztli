//! Changes waiting for the user: each one is announced to the UI, then waits
//! for an answer, a timeout, its caller to go away, its client to lose its
//! access, or the server to stop.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::oneshot;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::{ClientInfo, Decision, McpEvent, lock};

/// How often a waiting change reports progress, so clients that time out
/// idle requests keep waiting.
const PROGRESS_EVERY: Duration = Duration::from_secs(15);

/// Changes one client may have waiting at once. The user answers them one by
/// one, and each holds the note's text.
pub(crate) const MAX_PENDING: usize = 20;

/// What a change does to the note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Create,
    Edit,
    Move,
    Delete,
}

/// Something the person approving a change should look at twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Warning {
    /// Most of what the note says goes away.
    RemovesMost,
    /// Other notes link to it, and their links will lead nowhere.
    BreaksLinks,
}

/// A change the user must approve, as the approval dialog shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: u64,
    pub client_id: String,
    /// As registered in Itztli: the verified identity.
    pub client_name: String,
    /// What the client declared itself to be; unverified.
    pub client_info: Option<ClientInfo>,
    pub vault_id: String,
    pub vault_name: String,
    pub action: Action,
    pub path: String,
    /// Where a move takes it.
    pub to: Option<String>,
    /// What the note says, unless it is being created or moved.
    pub before: Option<String>,
    /// What it would say, unless it is being moved or deleted.
    pub after: Option<String>,
    /// Notes whose links a move rewrites, or a deletion breaks.
    pub affected: Vec<String>,
    pub warnings: Vec<Warning>,
    /// Why the client says it wants the change.
    pub reason: Option<String>,
    /// UTC, RFC 3339 with milliseconds, like the store's timestamps.
    pub requested_at: String,
    /// When it is refused unless answered.
    pub expires_at: String,
}

/// Tells the UI.
pub(crate) type Notify<'a> = dyn Fn(McpEvent) + Send + Sync + 'a;

/// Reported to the client while a change waits for approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub waited_secs: u64,
    pub timeout_secs: u64,
    pub message: String,
}

/// How a wait for approval ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Answer {
    Approved,
    Rejected,
    Timeout,
    /// The call was cancelled.
    Cancelled,
    /// The client was revoked or deleted, or may no longer change the vault.
    Revoked,
    /// The server stopped listening.
    Stopped,
}

impl Answer {
    pub fn decision(self) -> Decision {
        match self {
            Answer::Approved => Decision::Approved,
            Answer::Rejected => Decision::Rejected,
            Answer::Timeout => Decision::Timeout,
            Answer::Cancelled | Answer::Revoked | Answer::Stopped => Decision::Withdrawn,
        }
    }
}

pub(crate) struct Approvals {
    next_id: AtomicU64,
    pending: Mutex<BTreeMap<u64, Pending>>,
    /// [`PROGRESS_EVERY`], shorter in some tests.
    progress_every: Duration,
}

impl Default for Approvals {
    fn default() -> Self {
        Self::new(PROGRESS_EVERY)
    }
}

struct Pending {
    request: ApprovalRequest,
    answer: oneshot::Sender<Answer>,
}

impl Approvals {
    pub fn new(progress_every: Duration) -> Self {
        Self { next_id: AtomicU64::default(), pending: Mutex::default(), progress_every }
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn answer(&self, id: u64, approve: bool) -> bool {
        let Some(pending) = lock(&self.pending).remove(&id) else { return false };
        pending.answer.send(if approve { Answer::Approved } else { Answer::Rejected }).is_ok()
    }

    pub fn pending(&self) -> Vec<ApprovalRequest> {
        lock(&self.pending).values().map(|p| p.request.clone()).collect()
    }

    /// Changes of a client waiting now.
    pub fn count(&self, client_id: &str) -> usize {
        lock(&self.pending).values().filter(|p| p.request.client_id == client_id).count()
    }

    /// Withdraws a client's pending approvals, in one vault or in all: each
    /// of their waits ends as [`Answer::Revoked`]. Returns how many there were.
    pub fn withdraw_client(&self, client_id: &str, vault_id: Option<&str>) -> usize {
        let mut pending = lock(&self.pending);
        let theirs = |r: &ApprovalRequest| r.client_id == client_id && vault_id.is_none_or(|id| r.vault_id == id);
        let ids: Vec<u64> = pending.iter().filter(|(_, p)| theirs(&p.request)).map(|(id, _)| *id).collect();
        // Dropping an answer's sender wakes its wait.
        ids.iter().filter_map(|id| pending.remove(id)).count()
    }

    /// Withdraws every pending approval, the server having stopped: each of
    /// their waits ends as [`Answer::Stopped`]. Returns how many there were.
    pub fn withdraw_all(&self) -> usize {
        let pending = std::mem::take(&mut *lock(&self.pending));
        let count = pending.len();
        for (_, pending) in pending {
            let _ = pending.answer.send(Answer::Stopped);
        }
        count
    }

    /// Registers `request`, announces it, and waits for the user's answer,
    /// at most `timeout`, reporting `progress` every 15 s. `cancel`
    /// withdraws it, and so do [`withdraw_client`](Self::withdraw_client)
    /// and [`withdraw_all`](Self::withdraw_all).
    ///
    /// `client_active` is asked once the request is registered, before it
    /// is announced: a client revoked just before then would otherwise
    /// escape `withdraw_client`. Whatever ends the wait (dropping this
    /// future too), the request stops being pending and the UI hears how it
    /// ended.
    pub async fn wait(
        &self,
        notify: &Notify<'_>,
        request: ApprovalRequest,
        timeout: Duration,
        cancel: &CancellationToken,
        progress: &(dyn Fn(Progress) + Send + Sync),
        client_active: &(dyn Fn() -> bool + Send + Sync),
    ) -> Answer {
        let id = request.id;
        let (answer, mut answered) = oneshot::channel();
        lock(&self.pending).insert(id, Pending { request: request.clone(), answer });
        let mut waiting = Waiting { approvals: self, notify, id, decision: Decision::Withdrawn };
        if !client_active() {
            return Answer::Revoked;
        }
        notify(McpEvent::ApprovalRequested(request));

        let started = Instant::now();
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        let every = self.progress_every;
        let mut ticks = tokio::time::interval_at(started + every, every);
        let answer = loop {
            tokio::select! {
                // An answer that arrives with the deadline still counts.
                biased;
                // Only `withdraw_client` drops the sender unanswered.
                answer = &mut answered => break answer.unwrap_or(Answer::Revoked),
                () = &mut deadline => break Answer::Timeout,
                () = cancel.cancelled() => break Answer::Cancelled,
                _ = ticks.tick() => {
                    let waited_secs = started.elapsed().as_secs();
                    progress(Progress {
                        waited_secs,
                        timeout_secs: timeout.as_secs(),
                        message: format!(
                            "Waiting for the user to approve the change in Itztli ({waited_secs} of {} s)",
                            timeout.as_secs()
                        ),
                    });
                }
            }
        };
        waiting.decision = answer.decision();
        answer
    }
}

/// Ends a wait however it ends.
struct Waiting<'a> {
    approvals: &'a Approvals,
    notify: &'a Notify<'a>,
    id: u64,
    decision: Decision,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        lock(&self.approvals.pending).remove(&self.id);
        (self.notify)(McpEvent::ApprovalResolved { id: self.id, decision: self.decision });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Events;

    fn request(id: u64, client_id: &str) -> ApprovalRequest {
        ApprovalRequest {
            id,
            client_id: client_id.into(),
            client_name: client_id.into(),
            client_info: None,
            vault_id: "v".into(),
            vault_name: "Notes".into(),
            action: Action::Create,
            path: "a.md".into(),
            to: None,
            before: None,
            after: Some("text".into()),
            affected: Vec::new(),
            warnings: Vec::new(),
            reason: None,
            requested_at: String::new(),
            expires_at: String::new(),
        }
    }

    #[tokio::test]
    async fn a_client_revoked_before_the_announcement_is_never_asked_about() {
        let heard = Events::default();
        let notify = |event| heard.add(event);
        let approvals = Approvals::default();
        let cancel = CancellationToken::new();
        let wait = approvals.wait(&notify, request(1, "c1"), Duration::from_secs(60), &cancel, &|_| {}, &|| false);
        assert_eq!(wait.await, Answer::Revoked);
        assert!(approvals.pending().is_empty());
        let events = heard.all();
        assert!(matches!(events.as_slice(), [McpEvent::ApprovalResolved { id: 1, decision: Decision::Withdrawn }]), "{events:?}");
    }

    #[tokio::test]
    async fn withdrawing_a_client_ends_only_its_waits() {
        let heard = Events::default();
        let notify = |event| heard.add(event);
        let approvals = Approvals::default();
        let cancel = CancellationToken::new();
        let wait = |id, client| approvals.wait(&notify, request(id, client), Duration::from_secs(60), &cancel, &|_| {}, &|| true);
        let (mut first, mut second, mut other) = (Box::pin(wait(1, "c1")), Box::pin(wait(2, "c1")), Box::pin(wait(3, "c2")));
        // Registered and announced.
        for waiting in [&mut first, &mut second, &mut other] {
            assert!(futures_poll(waiting).is_none());
        }
        assert_eq!(approvals.pending().len(), 3);

        assert_eq!((approvals.count("c1"), approvals.count("c2")), (2, 1));
        assert_eq!(approvals.withdraw_client("c1", Some("another vault")), 0);
        assert_eq!(approvals.withdraw_client("c1", Some("v")), 2);
        assert_eq!((first.await, second.await), (Answer::Revoked, Answer::Revoked));
        assert_eq!(approvals.pending().iter().map(|r| r.id).collect::<Vec<_>>(), [3]);
        assert!(approvals.answer(3, false));
        assert_eq!(other.await, Answer::Rejected);
    }

    #[tokio::test]
    async fn withdrawing_all_ends_every_wait_as_stopped() {
        let heard = Events::default();
        let notify = |event| heard.add(event);
        let approvals = Approvals::default();
        let cancel = CancellationToken::new();
        let wait = |id, client| approvals.wait(&notify, request(id, client), Duration::from_secs(60), &cancel, &|_| {}, &|| true);
        let (mut first, mut other) = (Box::pin(wait(1, "c1")), Box::pin(wait(2, "c2")));
        for waiting in [&mut first, &mut other] {
            assert!(futures_poll(waiting).is_none());
        }

        assert_eq!(approvals.withdraw_all(), 2);
        assert_eq!((first.await, other.await), (Answer::Stopped, Answer::Stopped));
        assert!(approvals.pending().is_empty());
        assert!(!approvals.answer(1, true));
        let withdrawn = |e: &McpEvent| matches!(e, McpEvent::ApprovalResolved { decision: Decision::Withdrawn, .. });
        assert_eq!(heard.all().iter().filter(|e| withdrawn(e)).count(), 2);
    }

    /// Polls a future once.
    fn futures_poll<F: std::future::Future + Unpin>(future: &mut F) -> Option<F::Output> {
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        match std::pin::Pin::new(future).poll(&mut context) {
            std::task::Poll::Ready(output) => Some(output),
            std::task::Poll::Pending => None,
        }
    }
}
