//! Native windows use the exact same Chinese text catalog as TypeScript.
use serde_json::Value;
use std::sync::OnceLock;

static CATALOG: OnceLock<Value> = OnceLock::new();

pub fn text(key: &str, values: &[(&str, String)]) -> String {
    let catalog = CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/i18n/zh-CN.json"))
            .unwrap_or_else(|error| panic!("{error}"))
    });
    let Some((group, entry)) = key.rsplit_once('.') else { return key.to_owned(); };
    let Some(message) = catalog.get(group).and_then(|g| g.get(entry)).and_then(Value::as_str) else { return key.to_owned(); };
    // Scan the original template once. Parameter values are never substituted again.
    let mut result = String::new();
    let mut remaining = message;
    while let Some(start) = remaining.find('{') {
        result.push_str(&remaining[..start]);
        remaining = &remaining[start..];
        let Some(end) = remaining.find('}') else { break; };
        let name = &remaining[1..end];
        if let Some((_, value)) = values.iter().find(|(key, _)| *key == name) {
            result.push_str(value);
        } else {
            result.push_str(&remaining[..=end]);
        }
        remaining = &remaining[end + 1..];
    }
    result.push_str(remaining);
    result
}
