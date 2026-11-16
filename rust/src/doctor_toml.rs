//! Source-compatible small TOML parser used solely for the Codex warning.
use crate::{
    doctor_files,
    doctor_model::{Item, Text},
};
use serde_json::{Map, Value, json};
use std::path::Path;
type R<T> = Result<T, String>;
struct Parser<'a> {
    s: &'a str,
    i: usize,
    line: usize,
    depth: usize,
}
impl<'a> Parser<'a> {
    fn fail<T>(&self, s: &str) -> R<T> {
        Err(format!("строка {}: {s}", self.line))
    }
    fn at(&self, s: &str) -> bool {
        self.s[self.i..].starts_with(s)
    }
    fn peek(&self) -> Option<char> {
        self.s[self.i..].chars().next()
    }
    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.i += c.len_utf8();
        Some(c)
    }
    fn spaces(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.bump();
        }
    }
    fn comment(&mut self) {
        if self.at("#") {
            while self.peek().is_some_and(|c| c != '\n') {
                self.bump();
            }
        }
    }
    fn all(&mut self) {
        loop {
            self.spaces();
            self.comment();
            if self.at("\r\n") {
                self.i += 2;
                self.line += 1
            } else if self.at("\n") {
                self.i += 1;
                self.line += 1
            } else {
                break;
            }
        }
    }
    fn string(&mut self) -> R<String> {
        let quote = self.bump().unwrap();
        let triple = quote.to_string().repeat(2);
        let mut out = String::new();
        if self.at(&triple) {
            self.i += 2;
            let close = quote.to_string().repeat(3);
            loop {
                if self.peek().is_none() {
                    return self.fail("многострочная строка не закрыта");
                }
                if quote == '"' && self.at("\\") {
                    out.push(self.bump().unwrap());
                    if let Some(c) = self.bump() {
                        if c == '\n' {
                            self.line += 1
                        }
                        out.push(c)
                    }
                    continue;
                }
                if self.at(&close) {
                    let mut n = 3;
                    while n < 5 && self.s[self.i + n..].starts_with(quote) {
                        n += 1
                    }
                    out.push_str(&quote.to_string().repeat(n - 3));
                    self.i += n;
                    return Ok(out);
                }
                let c = self.bump().unwrap();
                if c == '\n' {
                    self.line += 1
                }
                out.push(c);
            }
        }
        loop {
            match self.peek() {
                None => return self.fail("строка не закрыта"),
                Some(c) if c == quote => {
                    self.bump();
                    return Ok(out);
                }
                Some('\n') => {
                    return self.fail(if quote == '"' {
                        "перевод строки в строке"
                    } else {
                        "строка не закрыта"
                    });
                }
                Some('\\') if quote == '"' => {
                    out.push(self.bump().unwrap());
                    if let Some(c) = self.bump() {
                        out.push(c)
                    }
                }
                _ => out.push(self.bump().unwrap()),
            }
        }
    }
    fn key(&mut self) -> R<Vec<String>> {
        let mut out = vec![];
        loop {
            self.spaces();
            let k = if matches!(self.peek(), Some('"' | '\'')) {
                self.string()?
            } else {
                let start = self.i;
                while self
                    .peek()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                {
                    self.bump();
                }
                if start == self.i {
                    return self.fail("ожидался ключ");
                }
                self.s[start..self.i].to_owned()
            };
            if ["__proto__", "constructor", "prototype"].contains(&k.as_str()) {
                return self.fail(&format!("ключ {k} не принимается"));
            }
            out.push(k);
            self.spaces();
            if !self.at(".") {
                return Ok(out);
            }
            self.i += 1;
        }
    }
    fn value(&mut self) -> R<Value> {
        self.depth += 1;
        if self.depth > 64 {
            return self.fail("превышен предел вложенности");
        };
        let r = self.inner_value();
        self.depth -= 1;
        r
    }
    fn inner_value(&mut self) -> R<Value> {
        self.spaces();
        if matches!(self.peek(), Some('"' | '\'')) {
            return self.string().map(Value::String);
        }
        if self.at("[") {
            self.i += 1;
            let mut out = vec![];
            loop {
                self.all();
                if self.at("]") {
                    self.i += 1;
                    return Ok(Value::Array(out));
                }
                out.push(self.value()?);
                self.all();
                if self.at(",") {
                    self.i += 1;
                    continue;
                }
                if self.at("]") {
                    self.i += 1;
                    return Ok(Value::Array(out));
                }
                return self.fail("ожидалась , или ] в массиве");
            }
        }
        if self.at("{") {
            self.i += 1;
            let mut out = Value::Object(Map::new());
            loop {
                self.all();
                if self.at("}") {
                    self.i += 1;
                    return Ok(out);
                }
                let k = self.key()?;
                if !self.at("=") {
                    return self.fail("ожидалось = во встроенной таблице");
                }
                self.i += 1;
                let v = self.value()?;
                assign(&mut out, &k, v, self.line)?;
                self.all();
                if self.at(",") {
                    self.i += 1;
                    continue;
                }
                if self.at("}") {
                    self.i += 1;
                    return Ok(out);
                }
                return self.fail("ожидалась , или } во встроенной таблице");
            }
        }
        let re = regex::Regex::new(r"^(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}[^\s,\]}#]*|[^\s,\]}#]+)")
            .unwrap();
        let tail = &self.s[self.i..];
        let Some(m) = re.find(tail) else {
            return self.fail("ожидалось значение");
        };
        let text = m.as_str();
        self.i += text.len();
        Ok(match text {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => Value::String(text.into()),
        })
    }
}
fn table_at<'a>(
    root: &'a mut Value,
    path: &[String],
    line: usize,
) -> R<&'a mut Map<String, Value>> {
    let mut current = root;
    for k in path {
        let o = current
            .as_object_mut()
            .ok_or_else(|| format!("строка {line}: ключ {k} — не таблица"))?;
        let v = o
            .entry(k.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Array(a) = v {
            current = a
                .last_mut()
                .ok_or_else(|| format!("строка {line}: ключ {k} — не таблица"))?
        } else {
            current = v
        }
        if !current.is_object() {
            return Err(format!("строка {line}: ключ {k} — не таблица"));
        }
    }
    current
        .as_object_mut()
        .ok_or_else(|| format!("строка {line}: не таблица"))
}
fn assign(root: &mut Value, path: &[String], value: Value, line: usize) -> R<()> {
    let parent = table_at(root, &path[..path.len() - 1], line)?;
    parent.insert(path.last().unwrap().clone(), value);
    Ok(())
}
fn parse(s: &str) -> R<Value> {
    let mut p = Parser {
        s,
        i: 0,
        line: 1,
        depth: 0,
    };
    let mut root = Value::Object(Map::new());
    let mut current = vec![];
    while p.i < s.len() {
        p.all();
        if p.i == s.len() {
            break;
        }
        if p.at("[[") {
            p.i += 2;
            let path = p.key()?;
            if !p.at("]]") {
                return p.fail("ожидалось ]]");
            }
            p.i += 2;
            let parent = table_at(&mut root, &path[..path.len() - 1], p.line)?;
            let v = parent
                .entry(path.last().unwrap().clone())
                .or_insert_with(|| Value::Array(vec![]));
            if !v.is_array() {
                *v = Value::Array(vec![])
            }
            v.as_array_mut().unwrap().push(Value::Object(Map::new()));
            current = path;
        } else if p.at("[") {
            p.i += 1;
            current = p.key()?;
            if !p.at("]") {
                return p.fail("ожидалось ]");
            }
            p.i += 1;
            table_at(&mut root, &current, p.line)?;
        } else {
            let key = p.key()?;
            if !p.at("=") {
                return p.fail("ожидалось =");
            }
            p.i += 1;
            let v = p.value()?;
            let mut path = current.clone();
            path.extend(key);
            assign(&mut root, &path, v, p.line)?;
        }
        p.spaces();
        p.comment();
        if p.i < s.len() && !p.at("\n") && !p.at("\r\n") {
            return p.fail("лишнее после значения");
        }
    }
    Ok(root)
}
pub(super) fn item(path: &Path, t: Text) -> Option<Item> {
    let text = doctor_files::follow(path, doctor_files::LIMIT).ok()??;
    let base = |status: &str, detail: String| {
        t.item("codex.network", "Песочница Codex и сеть", status, detail)
    };
    let r=match parse(&text){Ok(v)=>v,Err(e)=>return Some(base("warn",format!("config.toml codex не разобран ({e}) — доступ песочницы к сокету демона не проверен")).data(json!({"parsed":false})))};
    let mut access = r["sandbox_workspace_write"]["network_access"].as_bool();
    let mut from = "sandbox_workspace_write".to_owned();
    if let Some(profile) = r["profile"].as_str()
        && let Some(a) =
            r["profiles"][profile]["sandbox_workspace_write"]["network_access"].as_bool()
    {
        access = Some(a);
        from = format!("profiles.{profile}.sandbox_workspace_write")
    }
    let mut sockets = vec![];
    if let Some(perm) = r["default_permissions"].as_str() {
        let net = &r["permissions"][perm]["network"];
        let at = format!("permissions.{perm}.network");
        if net["dangerously_allow_all_unix_sockets"] == true {
            sockets.push(format!("{at}.dangerously_allow_all_unix_sockets = true"))
        }
        if net["allow_unix_sockets"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            sockets.push(format!("{at}.allow_unix_sockets"))
        }
        if net["unix_sockets"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
            || net["unix_sockets"]
                .as_object()
                .is_some_and(|a| !a.is_empty())
        {
            sockets.push(format!("{at}.unix_sockets"))
        }
    }
    let mut reasons = vec![];
    if access == Some(true) {
        reasons.push(format!("{from}.network_access = true"))
    }
    reasons.extend(sockets.clone());
    Some(if reasons.is_empty() {
        base("ok","сеть и unix-сокеты в песочнице выключены: в режимах «Только чтение», «Спрашивать» и «Правки в папке без вопросов» агент Codex не достанет сокет демона (в «Полном доступе» песочницы нет)".into()).data(json!({"networkAccess":false,"unixSockets":[]}))
    } else {
        base("warn",format!("песочница Codex с сетью: агент сможет обратиться к демону Пульта ({} в config.toml codex)",reasons.join("; "))).fix("убери эти настройки из config.toml codex (network_access = false; без unix-сокетов в профиле разрешений)").data(json!({"networkAccess":access==Some(true),"unixSockets":sockets}))
    })
}
