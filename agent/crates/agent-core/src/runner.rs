use async_trait::async_trait;
use std::{error::Error, fmt};

use crate::dag::{ExecutionStep, StepStatus};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorError {
    message: String,
    uncertain: bool,
}

impl ConnectorError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            uncertain: false,
        }
    }

    pub fn uncertain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            uncertain: true,
        }
    }

    pub fn is_uncertain(&self) -> bool {
        self.uncertain
    }
}

impl fmt::Display for ConnectorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ConnectorError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerError {
    StepNotFound,
    InvalidStepState,
    Store(String),
    Connector(ConnectorError),
}

impl fmt::Display for RunnerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StepNotFound => formatter.write_str("EXECUTION_STEP_NOT_FOUND"),
            Self::InvalidStepState => formatter.write_str("EXECUTION_STEP_STATE_INVALID"),
            Self::Store(message) => formatter.write_str(message),
            Self::Connector(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for RunnerError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionResult {
    Succeeded,
    Failed,
    NeedsReview,
}

#[async_trait]
pub trait ExecutionStore: Send + Sync {
    async fn step(&self, id: &str) -> Result<Option<ExecutionStep>, RunnerError>;
    async fn save_step(&self, step: &ExecutionStep) -> Result<(), RunnerError>;
}

#[async_trait]
pub trait Connector: Send + Sync {
    async fn execute(&self, step: &ExecutionStep) -> Result<(), ConnectorError>;
    async fn reconcile(&self, step: &ExecutionStep) -> Result<(), ConnectorError>;
    async fn verify(&self, step: &ExecutionStep) -> Result<bool, ConnectorError>;
}

pub struct Runner<'a, C> {
    connector: &'a C,
}

impl<'a, C: Connector> Runner<'a, C> {
    pub fn new(connector: &'a C) -> Self {
        Self { connector }
    }

    pub async fn run_step(
        &self,
        store: &impl ExecutionStore,
        step_id: &str,
    ) -> Result<ExecutionResult, RunnerError> {
        let mut step = store
            .step(step_id)
            .await?
            .ok_or(RunnerError::StepNotFound)?;
        match step.status {
            StepStatus::Succeeded => return Ok(ExecutionResult::Succeeded),
            StepStatus::Failed | StepStatus::Blocked => return Ok(ExecutionResult::Failed),
            StepStatus::NeedsReview => return Ok(ExecutionResult::NeedsReview),
            StepStatus::Pending => {
                step.status = StepStatus::Prepared;
                step.attempts = step.attempts.saturating_add(1);
                store.save_step(&step).await?;
            }
            _ => {}
        }

        if step.status == StepStatus::Prepared {
            step.status = StepStatus::InFlight;
            store.save_step(&step).await?;
            match self.connector.execute(&step).await {
                Ok(()) => {}
                Err(error) if error.is_uncertain() => {
                    self.connector
                        .reconcile(&step)
                        .await
                        .map_err(RunnerError::Connector)?;
                }
                Err(error) => {
                    step.status = StepStatus::Failed;
                    store.save_step(&step).await?;
                    return Err(RunnerError::Connector(error));
                }
            }
            step.status = StepStatus::Verifying;
            store.save_step(&step).await?;
        } else if step.status == StepStatus::InFlight {
            self.connector
                .reconcile(&step)
                .await
                .map_err(RunnerError::Connector)?;
            step.status = StepStatus::Verifying;
            store.save_step(&step).await?;
        }

        if step.status != StepStatus::Verifying {
            return Err(RunnerError::InvalidStepState);
        }
        match self.connector.verify(&step).await {
            Ok(true) => {
                step.status = StepStatus::Succeeded;
                store.save_step(&step).await?;
                Ok(ExecutionResult::Succeeded)
            }
            Ok(false) => {
                step.status = StepStatus::NeedsReview;
                store.save_step(&step).await?;
                Ok(ExecutionResult::NeedsReview)
            }
            Err(error) => {
                step.status = if error.is_uncertain() {
                    StepStatus::NeedsReview
                } else {
                    StepStatus::Failed
                };
                store.save_step(&step).await?;
                Err(RunnerError::Connector(error))
            }
        }
    }
}
