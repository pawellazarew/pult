//! Bounded reads of the authoritative global completion and accepted user event.
//! Call only from an owned blocking Store task, outside Driver/latest locks.
use crate::journal::EventStore;
use crate::turn_completion::{CompletedAnswer, CompletionReadError, CompletionRef};

pub(crate) fn read(
    store: &mut EventStore,
    reference: &CompletionRef,
) -> Result<CompletedAnswer, CompletionReadError> {
    let records = store
        .read_ids(&[reference.user_event_id(), reference.terminal_event_id()])
        .map_err(|_| CompletionReadError::Storage)?;
    if records.len() != 2 || records.iter().any(|r| r.json.get().len() > crate::MAX_LINE) {
        return Err(CompletionReadError::Invalid);
    }
    let user =
        serde_json::from_str(records[0].json.get()).map_err(|_| CompletionReadError::Invalid)?;
    let event =
        serde_json::from_str(records[1].json.get()).map_err(|_| CompletionReadError::Invalid)?;
    crate::turn_completion::decode(reference, &user, &event)
}
