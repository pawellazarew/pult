//! HTTP sources in Contract answer all reads; no JavaScript data module is needed.
use exact_plan::Value;
use exact_runner::{DataError, DataSource};

#[derive(Default, Clone, Copy)]
pub struct Pult;

impl DataSource for Pult {
    fn query(&mut self, source: &str, _: &[Value]) -> Result<Value, DataError> {
        Err(DataError::UnknownSource(source.into()))
    }
}
