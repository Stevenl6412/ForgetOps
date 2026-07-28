use std::{collections::HashMap, sync::Mutex};

use agent_core::{
    dag::{
        ExecutionStep, StepAction, StepStatus, VerificationExpectation, block_downstream, runnable,
    },
    runner::{Connector, ConnectorError, ExecutionResult, ExecutionStore, Runner, RunnerError},
};

fn step(id: &str, dependencies: &[&str]) -> ExecutionStep {
    ExecutionStep {
        id: id.to_owned(),
        operation_key: format!("operation-{id}"),
        connector: "test".to_owned(),
        action: StepAction::Erase,
        dependencies: dependencies
            .iter()
            .map(|dependency| (*dependency).to_owned())
            .collect(),
        status: StepStatus::Pending,
        attempts: 0,
        desired_state: VerificationExpectation::Absent,
        block_reason: None,
    }
}

#[test]
fn runnable_requires_every_dependency_to_succeed() {
    let mut prerequisite = step("first", &[]);
    prerequisite.status = StepStatus::Succeeded;
    let dependent = step("second", &["first"]);
    let unrelated = step("third", &[]);
    let steps = vec![prerequisite, dependent, unrelated];

    assert_eq!(
        runnable(&steps)
            .into_iter()
            .map(|step| step.id.as_str())
            .collect::<Vec<_>>(),
        vec!["second", "third"]
    );
}

#[test]
fn failed_dependency_blocks_downstream_with_normalized_reason() {
    let mut failed = step("first", &[]);
    failed.status = StepStatus::Failed;
    let mut steps = vec![failed, step("second", &["first"])];

    block_downstream(&mut steps);

    assert_eq!(steps[1].status, StepStatus::Blocked);
    assert_eq!(
        steps[1].block_reason.as_deref(),
        Some("dependency_failed:first")
    );
}

#[tokio::test]
async fn prepared_step_is_called_after_restart_and_then_completed() {
    let store = MemoryStore::with_step(step("erase", &[]));
    store.set_status("erase", StepStatus::Prepared);
    let connector = FakeConnector::default();

    let outcome = Runner::new(&connector)
        .run_step(&store, "erase")
        .await
        .unwrap();

    assert_eq!(outcome, ExecutionResult::Succeeded);
    assert_eq!(connector.execute_calls(), 1);
    assert_eq!(store.status("erase"), StepStatus::Succeeded);
}

#[tokio::test]
async fn in_flight_step_is_verified_without_a_second_mutation() {
    let store = MemoryStore::with_step(step("erase", &[]));
    store.set_status("erase", StepStatus::InFlight);
    let connector = FakeConnector::verified();

    let outcome = Runner::new(&connector)
        .run_step(&store, "erase")
        .await
        .unwrap();

    assert_eq!(outcome, ExecutionResult::Succeeded);
    assert_eq!(connector.execute_calls(), 0);
    assert_eq!(connector.verify_calls(), 1);
    assert_eq!(store.status("erase"), StepStatus::Succeeded);
}

#[tokio::test]
async fn completed_step_is_never_scheduled_again() {
    let mut completed = step("erase", &[]);
    completed.status = StepStatus::Succeeded;
    let store = MemoryStore::with_step(completed);
    let connector = FakeConnector::default();

    let outcome = Runner::new(&connector)
        .run_step(&store, "erase")
        .await
        .unwrap();

    assert_eq!(outcome, ExecutionResult::Succeeded);
    assert_eq!(connector.execute_calls(), 0);
}

#[tokio::test]
async fn uncertain_mutation_is_reconciled_without_repeating_the_effective_change() {
    let store = MemoryStore::with_step(step("erase", &[]));
    let connector = FakeConnector::uncertain();

    let outcome = Runner::new(&connector)
        .run_step(&store, "erase")
        .await
        .unwrap();

    assert_eq!(outcome, ExecutionResult::Succeeded);
    assert_eq!(connector.execute_calls(), 1);
    assert_eq!(connector.reconcile_calls(), 1);
    assert_eq!(connector.verify_calls(), 1);
    assert_eq!(store.status("erase"), StepStatus::Succeeded);
}

#[derive(Default)]
struct MemoryStore {
    steps: Mutex<HashMap<String, ExecutionStep>>,
}

impl MemoryStore {
    fn with_step(step: ExecutionStep) -> Self {
        let mut steps = HashMap::new();
        steps.insert(step.id.clone(), step);
        Self {
            steps: Mutex::new(steps),
        }
    }

    fn set_status(&self, id: &str, status: StepStatus) {
        self.steps.lock().unwrap().get_mut(id).unwrap().status = status;
    }

    fn status(&self, id: &str) -> StepStatus {
        self.steps.lock().unwrap()[id].status.clone()
    }
}

#[async_trait::async_trait]
impl ExecutionStore for MemoryStore {
    async fn step(&self, id: &str) -> Result<Option<ExecutionStep>, RunnerError> {
        Ok(self.steps.lock().unwrap().get(id).cloned())
    }

    async fn save_step(&self, step: &ExecutionStep) -> Result<(), RunnerError> {
        self.steps
            .lock()
            .unwrap()
            .insert(step.id.clone(), step.clone());
        Ok(())
    }
}

#[derive(Default)]
struct FakeConnector {
    uncertain: bool,
    execute_calls: Mutex<u8>,
    reconcile_calls: Mutex<u8>,
    verify_calls: Mutex<u8>,
}

impl FakeConnector {
    fn verified() -> Self {
        Self {
            uncertain: false,
            verify_calls: Mutex::new(0),
            ..Self::default()
        }
    }

    fn uncertain() -> Self {
        Self {
            uncertain: true,
            ..Self::default()
        }
    }

    fn execute_calls(&self) -> u8 {
        *self.execute_calls.lock().unwrap()
    }

    fn reconcile_calls(&self) -> u8 {
        *self.reconcile_calls.lock().unwrap()
    }

    fn verify_calls(&self) -> u8 {
        *self.verify_calls.lock().unwrap()
    }
}

#[async_trait::async_trait]
impl Connector for FakeConnector {
    async fn execute(&self, _step: &ExecutionStep) -> Result<(), ConnectorError> {
        *self.execute_calls.lock().unwrap() += 1;
        if self.uncertain {
            Err(ConnectorError::uncertain(
                "transport interrupted after mutation",
            ))
        } else {
            Ok(())
        }
    }

    async fn reconcile(&self, _step: &ExecutionStep) -> Result<(), ConnectorError> {
        *self.reconcile_calls.lock().unwrap() += 1;
        Ok(())
    }

    async fn verify(&self, _step: &ExecutionStep) -> Result<bool, ConnectorError> {
        *self.verify_calls.lock().unwrap() += 1;
        Ok(true)
    }
}
