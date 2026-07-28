use std::{collections::VecDeque, error::Error, fmt, time::Duration};

use agent_core::connection::{
    ConnectionDirective, ConnectionTransport, DeliveryDeduplicator, ReconnectBackoff,
    run_connection_loop,
};
use agent_protocol::AgentMessage;
use async_trait::async_trait;

#[tokio::test]
async fn websocket_failure_polls_until_retry_and_then_reconnects() {
    let mut transport = FakeTransport {
        websocket_results: VecDeque::from([Err(TestError), Ok(ConnectionDirective::Shutdown)]),
        poll_results: VecDeque::from([Ok(ConnectionDirective::Reconnect)]),
        poll_delays: Vec::new(),
    };
    let mut backoff = ReconnectBackoff::new(Duration::from_secs(1), Duration::from_secs(60));

    run_connection_loop(&mut transport, &mut backoff)
        .await
        .expect("connection loop should shut down cleanly");

    assert_eq!(transport.poll_delays.len(), 1);
    assert!(transport.poll_delays[0] <= Duration::from_secs(1));
    assert!(transport.websocket_results.is_empty());
}

#[test]
fn backoff_is_capped_and_resets_after_a_healthy_session() {
    let mut backoff = ReconnectBackoff::new(Duration::from_secs(1), Duration::from_secs(60));
    let delays: Vec<_> = (0..10)
        .map(|_| backoff.next_delay_with_jitter(u64::MAX))
        .collect();
    assert!(delays.iter().all(|delay| *delay <= Duration::from_secs(60)));
    assert_eq!(delays.last(), Some(&Duration::from_secs(60)));

    backoff.reset();
    assert_eq!(
        backoff.next_delay_with_jitter(u64::MAX),
        Duration::from_secs(1)
    );
}

#[test]
fn duplicate_job_delivery_is_not_executed_twice() {
    let mut deduplicator = DeliveryDeduplicator::new(32);
    let first = job_message("job_1", "msg_1");
    let duplicate = job_message("job_1", "msg_2");
    let second = job_message("job_2", "msg_3");

    assert!(deduplicator.accept(&first).expect("first job"));
    assert!(!deduplicator.accept(&duplicate).expect("duplicate job"));
    assert!(deduplicator.accept(&second).expect("second job"));
}

struct FakeTransport {
    websocket_results: VecDeque<Result<ConnectionDirective, TestError>>,
    poll_results: VecDeque<Result<ConnectionDirective, TestError>>,
    poll_delays: Vec<Duration>,
}

#[async_trait]
impl ConnectionTransport for FakeTransport {
    type Error = TestError;

    async fn websocket_session(&mut self) -> Result<ConnectionDirective, Self::Error> {
        self.websocket_results
            .pop_front()
            .expect("expected websocket result")
    }

    async fn poll_until_websocket_retry(
        &mut self,
        retry_after: Duration,
    ) -> Result<ConnectionDirective, Self::Error> {
        self.poll_delays.push(retry_after);
        self.poll_results.pop_front().expect("expected poll result")
    }
}

#[derive(Debug)]
struct TestError;

impl fmt::Display for TestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("test connection error")
    }
}

impl Error for TestError {}

fn job_message(job_id: &str, message_id: &str) -> AgentMessage {
    AgentMessage {
        r#type: "forgetops.agent-message".to_owned(),
        protocol_version: "1.0".to_owned(),
        message_type: "job.available".to_owned(),
        message_id: message_id.to_owned(),
        key_id: "control-key-1".to_owned(),
        environment_id: "env_1".to_owned(),
        agent_id: "agt_1".to_owned(),
        direction: "control_to_agent".to_owned(),
        sequence: "1".to_owned(),
        sent_at: "2026-07-23T08:00:00.000Z".to_owned(),
        payload: serde_json::json!({ "jobId": job_id }),
        signature: "test-signature".to_owned(),
    }
}
