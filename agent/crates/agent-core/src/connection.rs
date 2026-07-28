//! Connection fallback and delivery deduplication for the customer agent.

use std::{
    collections::{HashSet, VecDeque},
    error::Error,
    fmt,
    time::Duration,
};

use agent_protocol::AgentMessage;
use async_trait::async_trait;
use rand::{RngExt, rngs::SysRng};
use rand_core::UnwrapErr;

/// Tells the connection coordinator whether to reconnect or stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionDirective {
    Reconnect,
    Shutdown,
}

/// Transport operations owned by the concrete agent binary.
///
/// Keeping these operations behind a small interface lets the core coordinate
/// WebSocket-first delivery and polling fallback without owning HTTP details.
#[async_trait]
pub trait ConnectionTransport {
    type Error;

    async fn websocket_session(&mut self) -> Result<ConnectionDirective, Self::Error>;

    async fn poll_until_websocket_retry(
        &mut self,
        retry_after: Duration,
    ) -> Result<ConnectionDirective, Self::Error>;
}

/// Prefer WebSocket delivery and fall back to polling after connection errors.
pub async fn run_connection_loop<T>(
    transport: &mut T,
    backoff: &mut ReconnectBackoff,
) -> Result<(), T::Error>
where
    T: ConnectionTransport + Send,
{
    loop {
        match transport.websocket_session().await {
            Ok(ConnectionDirective::Shutdown) => return Ok(()),
            Ok(ConnectionDirective::Reconnect) => {
                backoff.reset();
            }
            Err(_) => {
                let retry_after = backoff.next_delay();
                match transport.poll_until_websocket_retry(retry_after).await? {
                    ConnectionDirective::Shutdown => return Ok(()),
                    ConnectionDirective::Reconnect => {}
                }
            }
        }
    }
}

/// Exponential reconnect delay with full jitter and a hard upper bound.
#[derive(Clone, Debug)]
pub struct ReconnectBackoff {
    base: Duration,
    maximum: Duration,
    attempt: u32,
}

impl ReconnectBackoff {
    pub fn new(base: Duration, maximum: Duration) -> Self {
        assert!(!base.is_zero(), "reconnect base delay must be positive");
        assert!(
            maximum >= base,
            "reconnect maximum delay must not be below the base delay"
        );
        Self {
            base,
            maximum,
            attempt: 0,
        }
    }

    pub fn next_delay(&mut self) -> Duration {
        let cap_millis = duration_millis(self.current_cap());
        let mut rng = UnwrapErr(SysRng);
        let jitter = rng.random_range(0..=cap_millis);
        self.advance();
        Duration::from_millis(jitter)
    }

    /// Deterministic jitter hook used by tests and seeded simulations.
    pub fn next_delay_with_jitter(&mut self, jitter_millis: u64) -> Duration {
        let cap_millis = duration_millis(self.current_cap());
        self.advance();
        Duration::from_millis(jitter_millis.min(cap_millis))
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    fn current_cap(&self) -> Duration {
        let multiplier = 1_u32.checked_shl(self.attempt.min(31)).unwrap_or(u32::MAX);
        self.base.saturating_mul(multiplier).min(self.maximum)
    }

    fn advance(&mut self) {
        self.attempt = self.attempt.saturating_add(1).min(31);
    }
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

/// Bounded in-memory guard against executing the same logical job twice.
#[derive(Debug)]
pub struct DeliveryDeduplicator {
    capacity: usize,
    job_ids: HashSet<String>,
    insertion_order: VecDeque<String>,
}

impl DeliveryDeduplicator {
    pub fn new(capacity: usize) -> Self {
        assert!(
            capacity > 0,
            "delivery deduplicator capacity must be positive"
        );
        Self {
            capacity,
            job_ids: HashSet::with_capacity(capacity),
            insertion_order: VecDeque::with_capacity(capacity),
        }
    }

    /// Returns `true` only for the first delivery of a `job.available` job ID.
    pub fn accept(&mut self, message: &AgentMessage) -> Result<bool, DeliveryError> {
        if message.message_type != "job.available" {
            return Err(DeliveryError::UnsupportedMessageType);
        }
        let job_id = message
            .payload
            .get("jobId")
            .and_then(|value| value.as_str())
            .filter(|job_id| !job_id.is_empty())
            .ok_or(DeliveryError::MissingJobId)?;
        if self.job_ids.contains(job_id) {
            return Ok(false);
        }

        if self.job_ids.len() == self.capacity
            && let Some(evicted_job_id) = self.insertion_order.pop_front()
        {
            self.job_ids.remove(&evicted_job_id);
        }
        self.job_ids.insert(job_id.to_owned());
        self.insertion_order.push_back(job_id.to_owned());
        Ok(true)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryError {
    UnsupportedMessageType,
    MissingJobId,
}

impl fmt::Display for DeliveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedMessageType => {
                formatter.write_str("delivery is not a job.available message")
            }
            Self::MissingJobId => formatter.write_str("delivery payload is missing jobId"),
        }
    }
}

impl Error for DeliveryError {}
