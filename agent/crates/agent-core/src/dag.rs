use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepAction {
    Discover,
    Export,
    Erase,
    Verify,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Prepared,
    InFlight,
    Verifying,
    Succeeded,
    Failed,
    NeedsReview,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationExpectation {
    Absent,
    Anonymized,
    Exported,
    Retained,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionStep {
    pub id: String,
    pub operation_key: String,
    pub connector: String,
    pub action: StepAction,
    pub dependencies: Vec<String>,
    pub status: StepStatus,
    pub attempts: u32,
    pub desired_state: VerificationExpectation,
    pub block_reason: Option<String>,
}

pub fn validate_dag(steps: &[ExecutionStep]) -> Result<(), &'static str> {
    let by_id: HashMap<&str, &ExecutionStep> =
        steps.iter().map(|step| (step.id.as_str(), step)).collect();
    if by_id.len() != steps.len()
        || steps.iter().any(|step| {
            step.id.is_empty()
                || step.operation_key.is_empty()
                || step.dependencies.iter().any(|dependency| {
                    dependency == &step.id || !by_id.contains_key(dependency.as_str())
                })
        })
    {
        return Err("EXECUTION_DAG_INVALID");
    }
    for step in steps {
        let mut visiting = HashSet::new();
        if has_cycle(step.id.as_str(), &by_id, &mut visiting) {
            return Err("EXECUTION_DAG_CYCLE");
        }
    }
    Ok(())
}

pub fn runnable(steps: &[ExecutionStep]) -> Vec<&ExecutionStep> {
    let statuses: HashMap<&str, &StepStatus> = steps
        .iter()
        .map(|step| (step.id.as_str(), &step.status))
        .collect();
    steps
        .iter()
        .filter(|step| {
            step.status == StepStatus::Pending
                && step.dependencies.iter().all(|dependency| {
                    statuses.get(dependency.as_str()) == Some(&&StepStatus::Succeeded)
                })
        })
        .collect()
}

pub fn block_downstream(steps: &mut [ExecutionStep]) {
    loop {
        let failed: HashSet<String> = steps
            .iter()
            .filter(|step| {
                matches!(
                    step.status,
                    StepStatus::Failed | StepStatus::NeedsReview | StepStatus::Blocked
                )
            })
            .map(|step| step.id.clone())
            .collect();
        let mut changed = false;
        for step in steps
            .iter_mut()
            .filter(|step| step.status == StepStatus::Pending)
        {
            if let Some(dependency) = step
                .dependencies
                .iter()
                .find(|dependency| failed.contains(*dependency))
            {
                step.status = StepStatus::Blocked;
                step.block_reason = Some(format!("dependency_failed:{dependency}"));
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
}

fn has_cycle<'a>(
    id: &'a str,
    by_id: &HashMap<&'a str, &'a ExecutionStep>,
    visiting: &mut HashSet<&'a str>,
) -> bool {
    if !visiting.insert(id) {
        return true;
    }
    let cycle = by_id[id]
        .dependencies
        .iter()
        .any(|dependency| has_cycle(dependency, by_id, visiting));
    visiting.remove(id);
    cycle
}
