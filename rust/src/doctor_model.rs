//! CLI-only diagnostic report and source-owned translation literals.
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::OnceLock};
#[derive(Clone, Copy)]
pub(super) struct Text(pub bool);
impl Text {
    pub fn t(self, source: &str, values: &[&str]) -> String {
        static EN: OnceLock<BTreeMap<String, String>> = OnceLock::new();
        let catalog = EN.get_or_init(|| {
            serde_json::from_str(include_str!("doctor_en.json")).expect("compiled doctor catalog")
        });
        let source = if self.0 {
            catalog.get(source).map(String::as_str).unwrap_or(source)
        } else {
            source
        };
        // Substitute source placeholders once; inserted foreign text cannot become a template.
        let re = regex::Regex::new(r"\{(\d+)\}").expect("static template regex");
        re.replace_all(source, |c: &regex::Captures<'_>| {
            values
                .get(c[1].parse::<usize>().unwrap())
                .map_or_else(|| c[0].to_owned(), |v| (*v).to_owned())
        })
        .into_owned()
    }
    pub fn item(self, id: &str, title: &str, status: &str, detail: String) -> Item {
        Item {
            id: id.into(),
            title: self.t(title, &[]),
            status: status.into(),
            detail,
            fix: None,
            fix_cmd: None,
            data: None,
            raw_detail: None,
            raw_login: None,
        }
    }
}
#[derive(Clone, Debug)]
pub(super) struct Item {
    pub id: String,
    pub title: String,
    pub status: String,
    pub detail: String,
    pub fix: Option<String>,
    pub fix_cmd: Option<String>,
    pub data: Option<Value>,
    // Only JS slice can split a pair; normal text remains UTF-8 for terminal IO.
    pub raw_detail: Option<Box<serde_json::value::RawValue>>,
    pub raw_login: Option<Box<serde_json::value::RawValue>>,
}
impl Serialize for Item {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = serializer.serialize_map(None)?;
        m.serialize_entry("id", &self.id)?;
        m.serialize_entry("title", &self.title)?;
        m.serialize_entry("status", &self.status)?;
        if let Some(raw) = &self.raw_detail {
            m.serialize_entry("detail", raw)?
        } else {
            m.serialize_entry("detail", &self.detail)?
        }
        if let Some(f) = &self.fix {
            m.serialize_entry("fix", f)?
        }
        if let Some(f) = &self.fix_cmd {
            m.serialize_entry("fixCmd", f)?
        }
        if let Some(login) = &self.raw_login {
            #[derive(Serialize)]
            struct Login<'a> {
                login: &'a serde_json::value::RawValue,
            }
            m.serialize_entry("data", &Login { login })?;
        } else if let Some(data) = &self.data {
            m.serialize_entry("data", data)?
        }
        m.end()
    }
}
pub(super) fn raw_string(units: &[u16]) -> Box<serde_json::value::RawValue> {
    serde_json::value::RawValue::from_string(pult_core::encode_js_string(units))
        .expect("reviewed JS string encoder")
}
impl Item {
    pub fn cmd(mut self, cmd: impl Into<String>) -> Self {
        let c = cmd.into();
        self.fix = Some(c.clone());
        self.fix_cmd = Some(c);
        self
    }
    pub fn fix(mut self, fix: impl Into<String>) -> Self {
        self.fix = Some(fix.into());
        self
    }
    pub fn data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Report {
    pub ok: bool,
    pub generated_at: String,
    pub home: String,
    pub items: Vec<Item>,
    pub counts: Value,
}
impl Report {
    pub fn new(home: String, items: Vec<Item>) -> Self {
        let count = |s: &str| items.iter().filter(|i| i.status == s).count();
        Self {
            ok: count("fail") == 0,
            generated_at: now(),
            home,
            counts: json!({"ok":count("ok"),"warn":count("warn"),"fail":count("fail")}),
            items,
        }
    }
    pub fn exit(&self) -> i32 {
        if self.ok {
            0
        } else if self
            .items
            .iter()
            .any(|i| i.status == "fail" && (i.id == "guard.rule" || i.id.starts_with("net.")))
        {
            4
        } else {
            1
        }
    }
    pub fn text(&self, t: Text) -> String {
        let mut lines = vec![format!("pult doctor · {}", self.home)];
        for i in &self.items {
            let s = match i.status.as_str() {
                "ok" => "ok  ",
                "warn" => "warn",
                _ => "FAIL",
            };
            lines.push(format!("[{s}] {}: {}", i.title, i.detail));
            if let Some(f) = &i.fix {
                lines.push(t.t("         почини: {0}", &[f]));
            }
        }
        lines.push(t.t(
            "итог: ok {0} · warn {1} · fail {2}",
            &[
                &self.counts["ok"].to_string(),
                &self.counts["warn"].to_string(),
                &self.counts["fail"].to_string(),
            ],
        ));
        lines.join("\n")
    }
}
pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(super) fn redact(s: &str) -> String {
    pult_core::redaction::redact_string(s)
}
pub(super) fn js(v: Option<&Value>) -> String {
    v.map_or_else(
        || "undefined".into(),
        |v| match v {
            Value::String(s) => s.clone(),
            _ => v.to_string(),
        },
    )
}
