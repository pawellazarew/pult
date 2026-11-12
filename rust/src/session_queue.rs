//! Durable ordinary-message queue and exact-ticket Codex steering. Unknown
//! sends retain their item and a persisted marker; Resume never retries them.
use crate::{
    State,
    registry::{Record, Registry},
    session_runtime_api::{self as api, Result},
    turn_snapshot::SessionKey,
};
use serde::{Serialize, Serializer};
use serde_json::{
    Value, json,
    value::{RawValue, to_raw_value},
};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::watch, time::Instant};
const MAX: usize = 20;
const TEXT_MAX: usize = 50_000;
const BYTES_MAX: usize = 256 * 1024;
const HOLD: Duration = Duration::from_secs(600);
type Token = Arc<watch::Sender<bool>>;
#[derive(Clone)]
struct Item {
    id: String,
    text: String,
    at: String,
    attachments: Vec<Value>,
    raw: Option<Record>,
}
impl Serialize for Item {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        if let Some(raw) = &self.raw {
            return raw.serialize(serializer);
        }
        let mut value = json!({"id":self.id,"text":self.text,"at":self.at});
        if !self.attachments.is_empty() {
            value["attachments"] = json!(self.attachments);
        }
        value.serialize(serializer)
    }
}
impl Item {
    fn raw_field(&self, key: &str) -> Box<RawValue> {
        self.raw
            .as_ref()
            .and_then(|r| r.get(key))
            .map(RawValue::to_owned)
            .unwrap_or_else(|| {
                to_raw_value(&match key {
                    "id" => json!(self.id),
                    "at" => json!(self.at),
                    "attachments" => json!(self.attachments),
                    _ => json!(self.text),
                })
                .expect("queue scalar")
            })
    }
    fn native_safe(&self) -> bool {
        self.raw.as_ref().is_none_or(|r| {
            r.raw()
                .is_ok_and(|v| serde_json::from_str::<Value>(v.get()).is_ok())
        })
    }
    fn identity_eq(&self, other: &Self) -> bool {
        ["id", "at"].iter().all(|field| {
            let units = |item: &Self| {
                item.raw
                    .as_ref()
                    .and_then(|r| r.string(field))
                    .unwrap_or_else(|| match *field {
                        "id" => item.id.encode_utf16().collect(),
                        _ => item.at.encode_utf16().collect(),
                    })
            };
            units(self) == units(other)
        })
    }
    fn same_id(&self, id: &str) -> bool {
        self.raw
            .as_ref()
            .and_then(|r| r.string("id"))
            .unwrap_or_else(|| self.id.encode_utf16().collect())
            == id.encode_utf16().collect::<Vec<_>>()
    }
    fn has_attachments(&self) -> bool {
        !self.attachments.is_empty()
            || self
                .raw
                .as_ref()
                .and_then(|r| r.get("attachments"))
                .is_some_and(|v| v.get() != "[]")
    }
    fn set_text(&mut self, text: &str) {
        self.text = text.into();
        if let Some(raw) = &mut self.raw {
            raw.set_string("text", text);
        }
    }
}
#[derive(Default)]
pub(crate) struct Queue {
    control: Mutex<Control>,
    // This mutex never spans Registry/FS or injected callbacks. Only this tiny
    // wakeup/worker bookkeeping is accessed on Tokio lanes.
    wakes: Mutex<(HashSet<SessionKey>, usize)>,
    timers: Mutex<HashSet<SessionKey>>,
}
#[derive(Default)]
struct Control {
    sending: HashMap<SessionKey, String>,
    pauses: HashMap<SessionKey, Arc<()>>,
    direct: HashSet<SessionKey>,
    draining: HashSet<SessionKey>,
    holds: HashMap<(SessionKey, String), (String, Instant)>,
    sent: HashMap<SessionKey, VecDeque<String>>,
}
fn current<'a>(reg: &'a Registry, key: &SessionKey) -> Result<&'a Record> {
    reg.find(&key.name)
        .filter(|r| r.scalar("createdAt").as_deref() == Some(&key.created_at))
        .ok_or_else(|| api::error("not_found", "session incarnation changed"))
}
fn record(reg: &Registry, name: &str) -> Result<Record> {
    reg.find(name)
        .filter(|r| r.get("archived").is_none_or(|v| v.get() != "true"))
        .cloned()
        .ok_or_else(|| api::error("not_found", "session does not exist"))
}
fn items(rec: &Record) -> Result<Vec<Item>> {
    let Some(raw) = rec.get("queue") else {
        return Ok(Vec::new());
    };
    crate::history::array_values(raw)
        .map_err(|_| api::invalid())?
        .iter()
        .map(|raw| {
            let fields: BTreeMap<String, Box<RawValue>> =
                serde_json::from_str(raw.get()).map_err(|_| api::invalid())?;
            let record = Record(fields);
            let decode = |key| {
                record
                    .string(key)
                    .map(|v| String::from_utf16_lossy(&v))
                    .ok_or_else(api::invalid)
            };
            let id = decode("id")?;
            let text = decode("text")?;
            let at = decode("at")?;
            let attachments = record
                .get("attachments")
                .and_then(|v| serde_json::from_str(v.get()).ok())
                .unwrap_or_default();
            Ok(Item {
                id,
                text,
                at,
                attachments,
                raw: Some(record),
            })
        })
        .collect()
}
fn paused(rec: &Record) -> bool {
    rec.get("queuePaused").is_some_and(|v| v.get() == "true")
}
fn uncertain(rec: &Record) -> bool {
    rec.get("queueDispatch").is_some()
}
fn save(rec: &mut Record, q: &[Item]) -> anyhow::Result<()> {
    if q.is_empty() {
        rec.remove("queue");
        rec.remove("queuePaused");
        rec.remove("queueDispatch");
    } else {
        rec.set_raw("queue", to_raw_value(q)?);
    }
    Ok(())
}
fn queue_state(rec: &Record) -> Result<Box<RawValue>> {
    let public = crate::session_model::public_record(rec).map_err(|_| api::invalid())?;
    let fields: BTreeMap<String, Box<RawValue>> =
        serde_json::from_str(public.get()).map_err(|_| api::invalid())?;
    let mut response = Record::default();
    response.set_string("name", rec.name());
    response.set_raw(
        "queue",
        fields
            .get("queue")
            .cloned()
            .unwrap_or_else(|| to_raw_value(&Vec::<Value>::new()).expect("empty queue")),
    );
    response.set_bool("queuePaused", paused(rec));
    response.raw().map_err(|_| api::invalid())
}
fn limits(q: &[Item]) -> Result<()> {
    let bytes = q
        .iter()
        .map(|v| {
            v.text.len()
                + if v.has_attachments() {
                    v.raw_field("attachments").get().len()
                } else {
                    0
                }
        })
        .sum::<usize>();
    if q.len() > MAX || q.iter().any(|v| v.text.chars().count() > TEXT_MAX) || bytes > BYTES_MAX {
        return Err(api::error(
            "invalid_params",
            "queue limit: 20 messages, 50000 characters each, 256 KiB total",
        ));
    }
    Ok(())
}
async fn io<T: Send + 'static>(
    state: Arc<State>,
    f: impl FnOnce(&mut Registry, &mut Control) -> Result<T> + Send + 'static,
) -> Result<T> {
    io_closing(state, false, f).await
}
async fn io_closing<T: Send + 'static>(
    state: Arc<State>,
    allow_closing: bool,
    f: impl FnOnce(&mut Registry, &mut Control) -> Result<T> + Send + 'static,
) -> Result<T> {
    let tracked = state.host_jobs.track();
    let failed = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _tracked = tracked;
        if !allow_closing {
            api::available(&state)?;
        }
        let _store = state.store.lock().map_err(|_| api::storage())?;
        let mut reg = state.registry.lock().map_err(|_| api::storage())?;
        let mut c = state
            .session_commands
            .queue
            .control
            .lock()
            .map_err(|_| api::storage())?;
        c.holds.retain(|_, v| v.1 > Instant::now());
        f(&mut reg, &mut c)
    })
    .await
    .unwrap_or_else(|_| Err(api::storage()));
    if result
        .as_ref()
        .is_err_and(|e| e.code == "storage_unavailable")
    {
        failed.execution_storage_failed();
    }
    result
}
fn update(
    reg: &mut Registry,
    key: &SessionKey,
    f: impl FnOnce(&mut Record) -> anyhow::Result<()>,
) -> Result<Record> {
    reg.update_checked(key, f).map_err(|_| api::storage())
}
fn busy(state: &State, key: &SessionKey) -> bool {
    crate::runtime_state::busy(state, key) || state.session_commands.pending(&key.name)
}
fn revoked(token: &watch::Sender<bool>) -> Result<()> {
    if *token.borrow() {
        Err(api::error("cancelled", "queued command was stopped"))
    } else {
        Ok(())
    }
}
fn find(q: &[Item], c: &Control, key: &SessionKey, id: &str) -> Result<usize> {
    q.iter().position(|v| v.same_id(id)).ok_or_else(|| {
        api::error(
            if c.sent.get(key).is_some_and(|v| v.iter().any(|v| v == id)) {
                "queue_item_sent"
            } else {
                "queue_item_removed"
            },
            "queued message has already been sent or removed",
        )
    })
}
fn remember(c: &mut Control, key: &SessionKey, id: String) {
    if !c.sent.contains_key(key)
        && c.sent.len() >= 1024
        && let Some(old) = c.sent.keys().next().cloned()
    {
        c.sent.remove(&old);
    }
    let sent = c.sent.entry(key.clone()).or_default();
    sent.push_back(id);
    while sent.len() > 50 {
        sent.pop_front();
    }
}
fn input(state: &State, key: &SessionKey, item: &Item) -> Result<crate::turn_driver::Input> {
    if !item.native_safe() {
        return Err(api::invalid());
    }
    let attachments = crate::prompt_attachments::validate_owned_prompt_attachments(
        &state.home,
        &key.name,
        Some(&json!(item.attachments)),
    )
    .map_err(|_| api::invalid())?;
    Ok(crate::turn_driver::Input {
        text: item.text.clone(),
        metadata: crate::turn_driver::InputMetadata {
            attachments,
            queue_item_id: Some(item.id.clone()),
            queue_item_at: Some(item.at.clone()),
            ..Default::default()
        },
    })
}
pub(crate) async fn pause(state: Arc<State>, key: SessionKey) -> Result<()> {
    io(state, move |reg, c| {
        if let Ok(rec) = current(reg, &key)
            && !items(rec)?.is_empty()
        {
            update(reg, &key, |r| {
                r.set_bool("queuePaused", true);
                Ok(())
            })?;
            c.pauses.insert(key.clone(), Arc::new(()));
        }
        Ok(())
    })
    .await
}
pub(crate) async fn before_release(
    state: Arc<State>,
    completion: crate::turn_driver::Completion,
) -> std::result::Result<(), crate::turn_driver::SinkError> {
    if completion.outcome() == &crate::turn_coordinator::Outcome::Success {
        return Ok(());
    }
    let key = completion.ticket().session().clone();
    io_closing(state, true, move |reg, c| {
        if let Ok(rec) = current(reg, &key)
            && !items(rec)?.is_empty()
        {
            update(reg, &key, |r| {
                r.set_bool("queuePaused", true);
                Ok(())
            })?;
            c.pauses.insert(key.clone(), Arc::new(()));
        }
        Ok(())
    })
    .await
    .map_err(|_| crate::turn_driver::SinkError {
        message: "queue pause result is unconfirmed".into(),
    })
}
pub(crate) fn observe(
    state: Arc<State>,
    key: SessionKey,
    mut progress: watch::Receiver<crate::turn_driver::Progress>,
) {
    let tracked = state.host_jobs.track();
    tokio::spawn(async move {
        let _tracked = tracked;
        loop {
            let done = match progress.borrow_and_update().clone() {
                crate::turn_driver::Progress::Finished(done) => Some(done),
                _ => None,
            };
            if done.is_some() {
                // Failure has already durably paused in before_release. A
                // subsequent explicit Resume must not lose this final wakeup.
                schedule(state, key);
                return;
            }
            if progress.changed().await.is_err() {
                return;
            }
        }
    });
}
async fn preparation_failed(state: Arc<State>, key: SessionKey, code: &str) -> Result<()> {
    if matches!(
        code,
        "network_denied"
            | "runtime_unavailable"
            | "invalid_session"
            | "internal"
            | "storage_unavailable"
            | "forbidden"
            | "start_unknown"
            | "invalid_path"
            | "unsupported_fork"
            | "provider_unavailable"
            | "unsupported"
    ) {
        pause(state, key).await?;
    }
    Ok(())
}
pub(crate) async fn prompt(
    state: Arc<State>,
    params: Value,
    command: Option<api::CommandGuard>,
    token: Token,
) -> Result<Box<RawValue>> {
    let name = api::name(&params)?;
    let text = params["text"].as_str().ok_or_else(api::invalid)?.to_owned();
    let checking = state.clone();
    let checking_name = name.clone();
    let values = params.get("attachments").cloned();
    let tracked = state.host_jobs.track();
    let attachments = tokio::task::spawn_blocking(move || {
        let _tracked = tracked;
        crate::prompt_attachments::validate_owned_prompt_attachments(
            &checking.home,
            &checking_name,
            values.as_ref(),
        )
        .map_err(|_| api::invalid())
    })
    .await
    .map_err(|_| api::storage())??;
    if text.chars().all(crate::runtime_config::js_space) && attachments.is_empty() {
        return Err(api::invalid());
    }
    let (key, provider) = api::lookup(state.clone(), name).await?;
    let checking_key = key.clone();
    let home = state.home.clone();
    io(state.clone(), move |reg, _| {
        let rec = current(reg, &checking_key)?;
        if rec.scalar("scope").as_deref() == Some("general") {
            let cwd = rec.scalar("cwd").ok_or_else(api::invalid)?;
            crate::host_paths::validate_general(
                &home,
                &checking_key.name,
                std::path::Path::new(&cwd),
            )
            .map_err(|_| {
                api::error(
                    "invalid_params",
                    "general workspace is invalid or unavailable",
                )
            })?;
        }
        Ok(())
    })
    .await?;
    revoked(&token)?;
    if !matches!(provider.as_str(), "codex" | "claude") && params["steer"] != true {
        return Err(api::error(
            "unsupported",
            "provider queue execution is unsupported",
        ));
    }
    if params["steer"] == true {
        if provider != "codex" {
            return Err(api::error(
                "invalid_params",
                "steering is only available for Codex",
            ));
        }
        let runtime = state
            .native_runtime
            .get()
            .ok_or_else(|| api::error("invalid_params", "no active Codex turn"))?;
        let turn = runtime
            .steer_guarded(
                &key,
                crate::turn_driver::Input {
                    text,
                    metadata: crate::turn_driver::InputMetadata {
                        attachments,
                        ..Default::default()
                    },
                },
                Some(token.subscribe()),
            )
            .await
            .map_err(|e| {
                api::error(
                    if e.code == "send_unknown" {
                        "send_unknown"
                    } else {
                        "invalid_params"
                    },
                    "steering was rejected; unknown delivery must not be retried automatically",
                )
            })?;
        return api::raw(json!({"turnId":turn}));
    }
    if params["queue"] == true {
        let is_busy = busy(&state, &key);
        let session = key.clone();
        let cancellation = token.clone();
        let queue_text = text.clone();
        let queue_attachments = attachments.clone();
        let queued = io(state.clone(), move |reg, c| {
            revoked(&cancellation)?;
            let rec = current(reg, &session)?.clone();
            let mut q = items(&rec)?;
            if !is_busy && !c.direct.contains(&session) && (q.is_empty() || paused(&rec)) {
                c.direct.insert(session);
                return Ok(None);
            }
            let mut bytes = [0u8; 4];
            let id = loop {
                getrandom::fill(&mut bytes).map_err(|_| api::storage())?;
                let id = bytes.iter().map(|v| format!("{v:02x}")).collect::<String>();
                if !q.iter().any(|v| v.id == id) {
                    break id;
                }
            };
            q.push(Item {
                id: id.clone(),
                text: queue_text,
                at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                attachments: queue_attachments.iter().map(|a| a.value()).collect(),
                raw: None,
            });
            limits(&q)?;
            update(reg, &session, |r| save(r, &q))?;
            Ok(Some(id))
        })
        .await?;
        if let Some(id) = queued {
            schedule(state, key);
            return api::raw(json!({"queued":true,"id":id}));
        }
    }
    let result = async {
        if params["interrupt"] == true {
            pause(state.clone(), key.clone()).await?;
            crate::runtime_state::stop(&state, &key, None).map_err(|_| api::storage())?;
            tokio::time::timeout(
                Duration::from_secs(10),
                crate::runtime_state::wait_idle(&state, &key),
            )
            .await
            .map_err(|_| {
                api::error(
                    "timeout",
                    "previous turn has not stopped; message was not sent",
                )
            })?;
        }
        revoked(&token)?;
        api::ordinary(
            state.clone(),
            params,
            command.as_ref(),
            Default::default(),
            key.clone(),
            token,
        )
        .await
    }
    .await;
    if let Err(error) = &result {
        preparation_failed(state.clone(), key.clone(), error.code).await?;
    }
    let copy = key.clone();
    let _ = io(state.clone(), move |_, c| {
        c.direct.remove(&copy);
        Ok(())
    })
    .await;
    drop(command);
    schedule(state, key);
    result
}

pub(crate) async fn request(
    state: Arc<State>,
    method: &str,
    params: Value,
    owner: &str,
    token: Token,
) -> Result<Box<RawValue>> {
    let name = api::name(&params)?;
    let allowed: &[&str] = match method {
        "agent.queue.move" => &["name", "id", "to", "hold", "text"],
        "agent.queue.resume" => &["name"],
        _ => &["name", "id"],
    };
    api::fields(&params, allowed)?;
    if method == "agent.queue.send" {
        return selected(
            state,
            name,
            params["id"].as_str().ok_or_else(api::invalid)?.into(),
            token,
            true,
        )
        .await;
    }
    let method = method.to_owned();
    let owner = owner.to_owned();
    let payload = params.clone();
    let (reply,key,provider)=io(state.clone(),move|reg,c|{
        let params=payload;
        let rich=method=="agent.queue.move"&&(params.get("text").is_some()||params["hold"]==true);
        let rec=record(reg,&name).map_err(|e|if rich&&e.code=="not_found"{api::error("queue_item_removed","queued message or session was removed")}else{e})?;
        let key=api::key(&rec)?;let provider=rec.scalar("provider").ok_or_else(api::invalid)?;let mut q=items(&rec)?;
        if method=="agent.queue.move"&&params["hold"]==false {
            if ["to","hold","text"].iter().filter(|v|params.get(**v).is_some()).count()!=1{return Err(api::invalid());}
            let id=params["id"].as_str().ok_or_else(api::invalid)?;c.holds.remove(&(key.clone(),id.into()));
            return Ok((queue_state(&rec)?,key,provider));
        }
        if c.sending.get(&key).is_some_and(|id|params["id"]==*id){return Err(api::error("busy","queued message is being sent"));}
        if method=="agent.queue.resume" {
            if !matches!(provider.as_str(),"codex"|"claude"){return Err(api::error("unsupported","provider queue execution is unsupported"));}
            if uncertain(&rec){return Err(api::error("send_unknown","previous delivery is unknown; Send now may duplicate it — explicitly Send now after cleanup, edit or remove the message"));}
            if q.first().is_some_and(|v|!v.native_safe()){return Err(api::error("invalid_params","legacy head contains unsupported Unicode; edit before resuming"));}
            let rec=update(reg,&key,|r|{r.remove("queuePaused");Ok(())})?;return Ok((queue_state(&rec)?,key,provider));
        }
        let id=params["id"].as_str().ok_or_else(api::invalid)?.to_owned();let at=find(&q,c,&key,&id).map_err(|e|if !rich{api::error("not_found","queued message was not found")}else{e})?;
        if method=="agent.queue.remove"{q.remove(at);c.holds.remove(&(key.clone(),id.clone()));}
        else {
            if ["to","hold","text"].iter().filter(|v|params.get(**v).is_some()).count()!=1{return Err(api::invalid());}
            if let Some(hold)=params.get("hold") {
                if hold.as_bool().ok_or_else(api::invalid)? {
                    c.holds.insert((key.clone(),id),(owner,Instant::now()+HOLD));
                    let mut response=Record(serde_json::from_str(queue_state(&rec)?.get()).map_err(|_|api::invalid())?);
                    let mut edit=Record::default();edit.set_raw("id",q[at].raw_field("id"));edit.set_raw("text",q[at].raw_field("text"));edit.set_number("holdMs",HOLD.as_millis() as f64);
                    if q[at].has_attachments(){edit.set_raw("attachments",q[at].raw_field("attachments"));}
                    response.set_raw("edit",edit.raw().map_err(|_|api::invalid())?);return Ok((response.raw().map_err(|_|api::invalid())?,key,provider));
                }else{c.holds.remove(&(key.clone(),id.clone()));}
            }else if let Some(text)=params.get("text") {
                let text=text.as_str().ok_or_else(api::invalid)?;if text.chars().all(crate::runtime_config::js_space)&&!q[at].has_attachments(){return Err(api::invalid());}
                q[at].set_text(text);limits(&q)?;c.holds.remove(&(key.clone(),id.clone()));
            }else{
                let to=params["to"].as_f64().filter(|v|v.is_finite()&&v.fract()==0.0&&v.abs()<=9_007_199_254_740_991.0).ok_or_else(api::invalid)? as i64;let item=q.remove(at);q.insert((to.max(0) as usize).min(q.len()),item);
            }
        }
        let rec=update(reg,&key,|r|{
            if (method=="agent.queue.remove"||params.get("text").is_some())&&r.get("queueDispatch").and_then(|v|serde_json::from_str::<Value>(v.get()).ok()).is_some_and(|v|v["id"]==id){r.remove("queueDispatch");}
            save(r,&q)
        })?;Ok((queue_state(&rec)?,key,provider))
    }).await?;
    if params.get("text").is_some() {
        state.execution_sink().append(json!({"sessionId":key.name,"provider":provider,"kind":"queue.updated","data":{"id":params["id"]}})).await.map_err(|_|api::storage())?;
    }
    schedule(state.clone(), key.clone());
    if params["hold"] == true {
        expiry(state, key);
    }
    Ok(reply)
}

async fn selected(
    state: Arc<State>,
    name: String,
    id: String,
    token: Token,
    explicit: bool,
) -> Result<Box<RawValue>> {
    let checking = state.clone();
    let requested = id;
    let cancellation = token.clone();
    let (key, item, was_paused, pause_epoch) = io(state.clone(), move |reg, c| {
        revoked(&cancellation)?;
        let rec = record(reg, &name).map_err(|e| {
            if e.code == "not_found" {
                api::error(
                    "queue_item_removed",
                    "queued message or session was removed",
                )
            } else {
                e
            }
        })?;
        let key = api::key(&rec)?;
        if !matches!(rec.scalar("provider").as_deref(), Some("codex" | "claude")) {
            return Err(api::error(
                "unsupported",
                "provider queue execution is unsupported",
            ));
        }
        if rec.scalar("provider").as_deref() == Some("claude")
            && checking
                .driver
                .get()
                .is_some_and(|driver| driver.active_ticket(&key).is_some())
        {
            return Err(api::error(
                "unsupported",
                "Claude live steering is not supported",
            ));
        }
        if c.sending.contains_key(&key) {
            return Err(api::error("busy", "queued message is already sending"));
        }
        if uncertain(&rec) && crate::runtime_state::busy(&checking, &key) {
            return Err(api::error(
                "cleanup_unconfirmed",
                "previous delivery is unknown; wait for cleanup before retry (which may duplicate)",
            ));
        }
        let q = items(&rec)?;
        let at = find(&q, c, &key, &requested)?;
        if !explicit && at != 0 {
            return Err(api::error("busy", "queue head changed before dispatch"));
        }
        if c.holds.contains_key(&(key.clone(), requested.clone())) {
            return Err(api::error(
                "invalid_params",
                "save or cancel this edit before sending",
            ));
        }
        if !explicit
            && (paused(&rec) || uncertain(&rec) || busy(&checking, &key) || c.direct.contains(&key))
        {
            return Err(api::error("busy", "queue is paused or session is busy"));
        }
        if !q[at].native_safe() {
            update(reg, &key, |r| {
                r.set_bool("queuePaused", true);
                Ok(())
            })?;
            return Err(api::error(
                "invalid_params",
                "legacy message contains unsupported Unicode; edit before sending",
            ));
        }
        update(reg, &key, |r| {
            r.set_raw(
                "queueDispatch",
                to_raw_value(&json!({"id":q[at].id,"at":q[at].at}))?,
            );
            r.set_bool("queuePaused", true);
            Ok(())
        })?;
        c.sending.insert(key.clone(), requested);
        let epoch = c.pauses.entry(key.clone()).or_default().clone();
        Ok((key, q[at].clone(), paused(&rec), epoch))
    })
    .await?;
    let operation = async {
        let runtime = crate::runtime_state::for_key(&state, &key)
            .await
            .map_err(|_| api::error("runtime_unavailable", "native runtime is unavailable"))?;
        revoked(&token)?;
        if state
            .driver
            .get()
            .is_some_and(|d| d.active_ticket(&key).is_some())
        {
            let checking = state.clone();
            let copy = item.clone();
            let session = key.clone();
            let tracked = state.host_jobs.track();
            let input = tokio::task::spawn_blocking(move || {
                let _tracked = tracked;
                input(&checking, &session, &copy)
            })
            .await
            .map_err(|_| api::storage())??;
            revoked(&token)?;
            let turn = runtime
                .steer_guarded(&key, input, Some(token.subscribe()))
                .await
                .map_err(|e| {
                    api::error(
                        if e.code == "send_unknown" {
                            "send_unknown"
                        } else {
                            "invalid_params"
                        },
                        "selected send was rejected, or its delivery is unknown",
                    )
                })?;
            api::raw(json!({"turnId":turn}))
        } else {
            api::ordinary(
                state.clone(),
                json!({"name":key.name,"text":item.text,"attachments":item.attachments}),
                None,
                crate::turn_driver::InputMetadata {
                    queue_item_id: Some(item.id.clone()),
                    queue_item_at: Some(item.at.clone()),
                    ..Default::default()
                },
                key.clone(),
                token.clone(),
            )
            .await
        }
    }
    .await;
    let succeeded = operation.is_ok();
    let definite = operation.as_ref().is_err_and(|e| {
        matches!(
            e.code,
            "busy"
                | "invalid_params"
                | "invalid_session"
                | "network_denied"
                | "forbidden"
                | "runtime_unavailable"
                | "invalid_path"
                | "unsupported_fork"
                | "provider_unavailable"
                | "unsupported"
        )
    });
    let session = key.clone();
    let settlement = if succeeded {
        Settlement::Accepted {
            item,
            was_paused,
            pause_epoch,
        }
    } else if definite {
        Settlement::DefiniteFailure
    } else {
        Settlement::Unknown
    };
    io(state.clone(), move |reg, c| {
        settle(reg, c, &session, settlement)
    })
    .await?;
    schedule(state, key);
    operation
}

enum Settlement {
    Accepted {
        item: Item,
        was_paused: bool,
        pause_epoch: Arc<()>,
    },
    DefiniteFailure,
    Unknown,
}
fn settle(
    reg: &mut Registry,
    c: &mut Control,
    key: &SessionKey,
    settlement: Settlement,
) -> Result<()> {
    c.sending.remove(key);
    if current(reg, key).is_err() {
        return Ok(());
    }
    match settlement {
        Settlement::Accepted {
            item,
            was_paused,
            pause_epoch,
        } => {
            let q = items(current(reg, key)?)?
                .into_iter()
                .filter(|v| !v.identity_eq(&item))
                .collect::<Vec<_>>();
            let may_resume = !was_paused
                && c.pauses
                    .get(key)
                    .is_some_and(|epoch| Arc::ptr_eq(epoch, &pause_epoch));
            update(reg, key, |r| {
                r.remove("queueDispatch");
                save(r, &q)?;
                if may_resume {
                    r.remove("queuePaused");
                }
                Ok(())
            })?;
            remember(c, key, item.id);
        }
        Settlement::DefiniteFailure => {
            update(reg, key, |r| {
                r.remove("queueDispatch");
                r.set_bool("queuePaused", true);
                Ok(())
            })?;
        }
        Settlement::Unknown => {}
    }
    Ok(())
}

pub(crate) fn schedule(state: Arc<State>, key: SessionKey) {
    if *state.stop.borrow() {
        return;
    }
    let launch = {
        let mut wakes = state
            .session_commands
            .queue
            .wakes
            .lock()
            .expect("queue wakeups");
        wakes.0.insert(key);
        if wakes.1 < 64 {
            wakes.1 += 1;
            true
        } else {
            false
        }
    };
    if !launch {
        return;
    }
    let tracked = state.host_jobs.track();
    tokio::spawn(async move {
        let _tracked = tracked;
        loop {
            let key = {
                let mut wakes = state
                    .session_commands
                    .queue
                    .wakes
                    .lock()
                    .expect("queue wakeups");
                if *state.stop.borrow() {
                    wakes.0.clear();
                }
                match wakes.0.iter().next().cloned() {
                    Some(key) => {
                        wakes.0.remove(&key);
                        key
                    }
                    None => {
                        wakes.1 -= 1;
                        return;
                    }
                }
            };
            let copy = key.clone();
            let checking = state.clone();
            let head = io(state.clone(), move |reg, c| {
                if !c.draining.insert(copy.clone()) {
                    return Ok(None);
                }
                let Ok(rec) = current(reg, &copy) else {
                    c.draining.remove(&copy);
                    return Ok(None);
                };
                let q = items(rec)?;
                if rec.get("archived").is_some_and(|v| v.get() == "true")
                    || !matches!(rec.scalar("provider").as_deref(), Some("codex" | "claude"))
                {
                    if !q.is_empty() {
                        update(reg, &copy, |r| {
                            r.set_bool("queuePaused", true);
                            Ok(())
                        })?;
                    }
                    c.draining.remove(&copy);
                    return Ok(None);
                }
                if paused(rec)
                    || c.direct.contains(&copy)
                    || uncertain(rec)
                    || busy(&checking, &copy)
                    || c.sending.contains_key(&copy)
                {
                    c.draining.remove(&copy);
                    return Ok(None);
                }
                let head = q
                    .first()
                    .filter(|v| !c.holds.contains_key(&(copy.clone(), v.id.clone())))
                    .map(|v| v.id.clone());
                if head.is_none() {
                    c.draining.remove(&copy);
                }
                Ok(head)
            })
            .await;
            if let Ok(Some(id)) = head {
                let token = Arc::new(watch::channel(false).0);
                state.session_commands.register_advanced(&key.name, &token);
                let _ = selected(state.clone(), key.name.clone(), id, token, false).await;
                let copy = key.clone();
                let checking = state.clone();
                let ready = io(state.clone(), move |reg, c| {
                    c.draining.remove(&copy);
                    let Ok(rec) = current(reg, &copy) else {
                        return Ok(false);
                    };
                    if rec.get("archived").is_some_and(|v| v.get() == "true")
                        || !matches!(rec.scalar("provider").as_deref(), Some("codex" | "claude"))
                    {
                        update(reg, &copy, |r| {
                            if r.get("queue").is_some() {
                                r.set_bool("queuePaused", true);
                            }
                            Ok(())
                        })?;
                        return Ok(false);
                    }
                    Ok(!busy(&checking, &copy)
                        && !c.direct.contains(&copy)
                        && !paused(rec)
                        && !uncertain(rec)
                        && items(rec)?
                            .first()
                            .is_some_and(|v| !c.holds.contains_key(&(copy.clone(), v.id.clone()))))
                })
                .await
                .unwrap_or(false);
                if ready {
                    schedule(state.clone(), key);
                }
            }
        }
    });
}
fn expiry(state: Arc<State>, key: SessionKey) {
    if !state
        .session_commands
        .queue
        .timers
        .lock()
        .expect("queue timers")
        .insert(key.clone())
    {
        return;
    }
    let tracked = state.host_jobs.track();
    let mut stop = state.stop.subscribe();
    tokio::spawn(async move {
        let _tracked = tracked;
        loop {
            if *stop.borrow() {
                break;
            }
            let copy = key.clone();
            let until = io(state.clone(), move |_, c| {
                Ok(c.holds
                    .iter()
                    .filter(|(k, _)| k.0 == copy)
                    .map(|(_, v)| v.1)
                    .min())
            })
            .await
            .unwrap_or(None);
            let Some(until) = until else {
                schedule(state.clone(), key.clone());
                break;
            };
            tokio::select! {_=tokio::time::sleep_until(until)=>schedule(state.clone(),key.clone()),_=stop.changed()=>break}
        }
        state
            .session_commands
            .queue
            .timers
            .lock()
            .expect("queue timers")
            .remove(&key);
    });
}
pub(crate) fn release_owner(state: Arc<State>, owner: &str) -> crate::turn_driver::Task<()> {
    let owner = owner.to_owned();
    let tracked = state.host_jobs.track();
    let (done, wait) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _tracked = tracked;
        let keys = io(state.clone(), move |_, c| {
            let keys = c
                .holds
                .iter()
                .filter(|(_, v)| v.0 == owner)
                .map(|(k, _)| k.0.clone())
                .collect::<HashSet<_>>();
            c.holds.retain(|_, v| v.0 != owner);
            Ok(keys)
        })
        .await
        .unwrap_or_default();
        for key in keys {
            schedule(state.clone(), key);
        }
        let _ = done.send(());
    });
    Box::pin(async move {
        let _ = wait.await;
    })
}
pub(crate) struct ConnectionLease(pub Arc<State>, pub String);
impl Drop for ConnectionLease {
    fn drop(&mut self) {
        drop(release_owner(self.0.clone(), &self.1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Arc<State>, SessionKey) {
        let (home, state) = api::tests::fixture();
        let key = SessionKey {
            name: "chat".into(),
            created_at: "2026-11-12T00:00:00Z".into(),
        };
        let mut rec = Record::default();
        for (k, v) in [
            ("name", "chat"),
            ("createdAt", key.created_at.as_str()),
            ("cwd", home.path().to_str().unwrap()),
            ("provider", "codex"),
            ("scope", "project"),
        ] {
            rec.set_string(k, v);
        }
        let q = vec![item("a", "first", "time-a"), item("b", "second", "time-b")];
        rec.set_raw("queue", to_raw_value(&q).unwrap());
        rec.set_bool("queuePaused", true);
        state.registry.lock().unwrap().insert(rec).unwrap();
        (home, state, key)
    }
    fn item(id: &str, text: &str, at: &str) -> Item {
        Item {
            id: id.into(),
            text: text.into(),
            at: at.into(),
            attachments: vec![],
            raw: None,
        }
    }
    async fn call(state: &Arc<State>, method: &str, params: Value) -> Result<Box<RawValue>> {
        api::execute(
            state.clone(),
            method,
            params,
            crate::host_policy::ClientKind::Other,
            "owner#1",
        )
        .await
    }
    fn value(raw: impl AsRef<RawValue>) -> Value {
        serde_json::from_str(raw.as_ref().get()).unwrap()
    }
    async fn finish(state: Arc<State>) {
        state.stop.send_replace(true);
        tokio::time::timeout(Duration::from_secs(5), state.host_jobs.wait())
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn edit_preserves_identity_order_and_only_journals_id() {
        let (_home, state, key) = fixture();
        let held = value(
            call(
                &state,
                "agent.queue.move",
                json!({"name":"chat","id":"a","hold":true}),
            )
            .await
            .unwrap(),
        );
        assert_eq!(held["edit"]["text"], "first");
        let text = "🦀".repeat(250);
        let edited = value(
            call(
                &state,
                "agent.queue.move",
                json!({"name":"chat","id":"a","text":text}),
            )
            .await
            .unwrap(),
        );
        assert_eq!(
            edited["queue"][0]["text"].as_str().unwrap().chars().count(),
            200
        );
        let rec = state
            .registry
            .lock()
            .unwrap()
            .find(&key.name)
            .unwrap()
            .clone();
        let q = items(&rec).unwrap();
        assert_eq!(
            (q[0].id.as_str(), q[0].at.as_str(), q[0].text.as_str()),
            ("a", "time-a", text.as_str())
        );
        let events = state
            .store
            .lock()
            .unwrap()
            .read_session(&"chat".encode_utf16().collect::<Vec<_>>())
            .unwrap();
        assert_eq!(events.len(), 1);
        let event: Value = serde_json::from_str(events[0].json.get()).unwrap();
        assert_eq!(event["kind"], "queue.updated");
        assert_eq!(event["data"], json!({"id":"a"}));
        finish(state).await;
    }
    #[tokio::test]
    async fn unknown_marker_blocks_resume_reorder_does_not_authorize_retry() {
        let (_home, state, key) = fixture();
        state
            .registry
            .lock()
            .unwrap()
            .update_checked(&key, |r| {
                r.set_raw(
                    "queueDispatch",
                    to_raw_value(&json!({"id":"a","at":"time-a"}))?,
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(
            call(&state, "agent.queue.resume", json!({"name":"chat"}))
                .await
                .unwrap_err()
                .code,
            "send_unknown"
        );
        let rec = state.registry.lock().unwrap().find("chat").unwrap().clone();
        assert!(
            crate::session_model::public_record(&rec)
                .unwrap()
                .get()
                .contains("Delivery unknown")
        );
        call(
            &state,
            "agent.queue.move",
            json!({"name":"chat","id":"a","to":1}),
        )
        .await
        .unwrap();
        assert!(
            state
                .registry
                .lock()
                .unwrap()
                .find("chat")
                .unwrap()
                .get("queueDispatch")
                .is_some()
        );
        call(
            &state,
            "agent.queue.move",
            json!({"name":"chat","id":"a","text":"changed deliberately"}),
        )
        .await
        .unwrap();
        assert!(
            state
                .registry
                .lock()
                .unwrap()
                .find("chat")
                .unwrap()
                .get("queueDispatch")
                .is_none()
        );
        finish(state).await;
    }
    #[tokio::test]
    async fn sending_item_is_reserved_but_other_reorders_survive() {
        let (_home, state, key) = fixture();
        state
            .session_commands
            .queue
            .control
            .lock()
            .unwrap()
            .sending
            .insert(key, "a".into());
        assert_eq!(
            call(
                &state,
                "agent.queue.remove",
                json!({"name":"chat","id":"a"})
            )
            .await
            .unwrap_err()
            .code,
            "busy"
        );
        call(
            &state,
            "agent.queue.move",
            json!({"name":"chat","id":"b","to":0}),
        )
        .await
        .unwrap();
        assert_eq!(
            items(state.registry.lock().unwrap().find("chat").unwrap()).unwrap()[0].id,
            "b"
        );
        finish(state).await;
    }
    #[tokio::test]
    async fn disconnect_releases_only_its_connections_holds() {
        let (_home, state, key) = fixture();
        call(
            &state,
            "agent.queue.move",
            json!({"name":"chat","id":"a","hold":true}),
        )
        .await
        .unwrap();
        state
            .session_commands
            .queue
            .control
            .lock()
            .unwrap()
            .holds
            .insert(
                (key.clone(), "b".into()),
                ("other".into(), Instant::now() + HOLD),
            );
        release_owner(state.clone(), "owner#1").await;
        {
            let c = state.session_commands.queue.control.lock().unwrap();
            assert!(!c.holds.contains_key(&(key.clone(), "a".into())));
            assert!(c.holds.contains_key(&(key, "b".into())));
        }
        finish(state).await;
    }
    #[test]
    fn limits_count_unicode_points_and_utf8_bytes() {
        let mut i = item("a", &"🦀".repeat(TEXT_MAX), "t");
        assert!(limits(&[i.clone()]).is_ok());
        i.text.push('🦀');
        assert!(limits(&[i]).is_err());
        let i = item("a", &"🦀".repeat(40_000), "t");
        assert!(limits(&[i.clone(), i]).is_err());
        assert!(limits(&vec![item("a", "x", "t"); 21]).is_err());
    }
    #[tokio::test]
    async fn legacy_utf16_is_preserved_and_unsendable_head_pauses_without_global_fault() {
        let (_home, state, key) = fixture();
        state.registry.lock().unwrap().update_checked(&key,|r|{r.set_raw("queue",RawValue::from_string(r#"[{"id":"a","text":"legacy\ud800","at":"time-a"},{"id":"b","text":"second","at":"time-b"}]"#.into())?);Ok(())}).unwrap();
        call(
            &state,
            "agent.queue.move",
            json!({"name":"chat","id":"b","text":"new second"}),
        )
        .await
        .unwrap();
        call(
            &state,
            "agent.queue.move",
            json!({"name":"chat","id":"b","to":0}),
        )
        .await
        .unwrap();
        call(
            &state,
            "agent.queue.remove",
            json!({"name":"chat","id":"b"}),
        )
        .await
        .unwrap();
        assert_eq!(
            call(&state, "agent.queue.send", json!({"name":"chat","id":"a"}))
                .await
                .unwrap_err()
                .code,
            "invalid_params"
        );
        assert!(!crate::runtime_state::unavailable(&state));
        let rec = state.registry.lock().unwrap().find("chat").unwrap().clone();
        assert!(rec.get("queue").unwrap().get().contains(r"\ud800"));
        assert!(paused(&rec));
        assert!(rec.get("queueDispatch").is_none());
        finish(state).await;
    }
    #[tokio::test]
    async fn expired_hold_releases_without_timing_sleep() {
        let (_home, state, key) = fixture();
        state
            .session_commands
            .queue
            .control
            .lock()
            .unwrap()
            .holds
            .insert(
                (key.clone(), "a".into()),
                ("owner#1".into(), Instant::now()),
            );
        expiry(state.clone(), key);
        tokio::time::timeout(Duration::from_secs(5), state.host_jobs.wait())
            .await
            .unwrap();
        assert!(
            state
                .session_commands
                .queue
                .control
                .lock()
                .unwrap()
                .holds
                .is_empty()
        );
        assert_eq!(
            items(state.registry.lock().unwrap().find("chat").unwrap()).unwrap()[0].text,
            "first"
        );
        finish(state).await;
    }
    #[tokio::test]
    async fn stop_revokes_advanced_command_before_owned_tasks_are_polled() {
        let (_home, state, _) = fixture();
        let token = Arc::new(watch::channel(false).0);
        state.session_commands.register_advanced("chat", &token);
        drop(api::execute(
            state.clone(),
            "agent.stop",
            json!({"name":"chat"}),
            crate::host_policy::ClientKind::Other,
            "owner#1",
        ));
        assert!(*token.borrow());
        finish(state).await;
    }
    #[tokio::test]
    async fn driver_terminal_pause_is_durable_before_release_without_async_observer() {
        use crate::turn_coordinator::{Outcome, Ticket};
        use crate::turn_driver::{Started, Task, Worker, WorkerError};
        use crate::turn_snapshot::{Provider, TurnSettings, TurnSnapshot};
        struct Fake {
            pre_ack: bool,
            done: Mutex<Option<tokio::sync::oneshot::Receiver<Outcome>>>,
        }
        impl Worker for Fake {
            fn start(
                &self,
                _: Ticket,
                _: TurnSnapshot,
                _: String,
            ) -> Task<std::result::Result<Started, WorkerError>> {
                let done = self.done.lock().unwrap().take().unwrap();
                let fail = self.pre_ack;
                Box::pin(async move {
                    if fail {
                        return Err(WorkerError {
                            code: "fixture".into(),
                            message: "failed before ack".into(),
                        });
                    }
                    Ok(Started {
                        turn_id: "pult-fixture".into(),
                        done: Box::pin(async move { done.await.unwrap() }),
                    })
                })
            }
            fn close(&self, _: Ticket) -> Task<std::result::Result<(), WorkerError>> {
                Box::pin(async { Ok(()) })
            }
        }
        for pre_ack in [false, true] {
            let (_home, state, key) = fixture();
            state
                .registry
                .lock()
                .unwrap()
                .update_checked(&key, |r| {
                    r.remove("queuePaused");
                    Ok(())
                })
                .unwrap();
            let (complete, done) = tokio::sync::oneshot::channel();
            let driver = state.driver.get().unwrap();
            let mut handle = driver
                .start(
                    TurnSnapshot {
                        key,
                        provider: Provider::Codex,
                        cwd: state.home.clone(),
                        settings: TurnSettings::default(),
                    },
                    "direct".into(),
                    Arc::new(Fake {
                        pre_ack,
                        done: Mutex::new(Some(done)),
                    }),
                )
                .unwrap();
            if !pre_ack {
                handle.accepted().await.unwrap();
                complete
                    .send(Outcome::Failure {
                        code: "fixture".into(),
                        message: "failed".into(),
                    })
                    .unwrap();
            }
            tokio::time::timeout(Duration::from_secs(5), handle.wait())
                .await
                .unwrap()
                .unwrap();
            assert!(paused(state.registry.lock().unwrap().find("chat").unwrap()));
            assert_eq!(driver.active_count(), 0);
            finish(state).await;
        }
    }
    #[test]
    fn receipt_pair_identity_never_collapses_lone_surrogate_to_replacement() {
        let mut rec = Record::default();
        rec.set_raw("queue",RawValue::from_string(r#"[{"id":"\ud800","text":"opaque","at":"same"},{"id":"�","text":"valid","at":"same"}]"#.into()).unwrap());
        let q = items(&rec).unwrap();
        assert!(!q[0].identity_eq(&q[1]));
        assert!(!q[0].same_id("�"));
        assert!(q[1].same_id("�"));
        let rest = q
            .iter()
            .filter(|v| !v.identity_eq(&q[1]))
            .cloned()
            .collect::<Vec<_>>();
        save(&mut rec, &rest).unwrap();
        assert!(rec.get("queue").unwrap().get().contains(r"\ud800"));
    }
    #[tokio::test]
    async fn accepted_settlement_never_erases_a_newer_terminal_or_stop_pause() {
        for newer in [false, true] {
            let (_home, state, key) = fixture();
            let captured = Arc::new(());
            let initial = captured.clone();
            let copy = key.clone();
            io(state.clone(), move |reg, c| {
                c.pauses
                    .insert(copy.clone(), if newer { Arc::new(()) } else { initial });
                update(reg, &copy, |r| {
                    r.set_bool("queuePaused", true);
                    r.set_raw(
                        "queueDispatch",
                        to_raw_value(&json!({"id":"a","at":"time-a"}))?,
                    );
                    Ok(())
                })?;
                settle(
                    reg,
                    c,
                    &copy,
                    Settlement::Accepted {
                        item: item("a", "first", "time-a"),
                        was_paused: false,
                        pause_epoch: captured,
                    },
                )
            })
            .await
            .unwrap();
            let rec = state.registry.lock().unwrap().find("chat").unwrap().clone();
            assert_eq!(paused(&rec), newer);
            assert_eq!(items(&rec).unwrap()[0].id, "b");
            assert!(rec.get("queueDispatch").is_none());
            finish(state).await;
        }
    }
    #[tokio::test]
    async fn invalid_general_workspace_rejects_before_enqueue_or_runtime() {
        let (_home, state, key) = fixture();
        state
            .registry
            .lock()
            .unwrap()
            .update_checked(&key, |r| {
                r.set_string("scope", "general");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            call(
                &state,
                "agent.prompt",
                json!({"name":"chat","text":"must not enqueue","queue":true})
            )
            .await
            .unwrap_err()
            .code,
            "invalid_params"
        );
        assert_eq!(
            items(state.registry.lock().unwrap().find("chat").unwrap())
                .unwrap()
                .len(),
            2
        );
        assert!(state.native_runtime.get().is_none());
        assert_eq!(
            state
                .last_event_id
                .load(std::sync::atomic::Ordering::Acquire),
            0
        );
        finish(state).await;
    }
    #[tokio::test]
    async fn archived_or_unsupported_provider_queue_pauses_without_spin_or_spawn() {
        for archived in [false, true] {
            let (_home, state, key) = fixture();
            {
                let mut reg = state.registry.lock().unwrap();
                let mut rec = reg.remove_checked(&key).unwrap();
                rec.remove("queuePaused");
                if archived {
                    rec.set_bool("archived", true);
                } else {
                    rec.set_string("provider", "zcode");
                }
                reg.insert(rec).unwrap();
            }
            schedule(state.clone(), key);
            tokio::time::timeout(Duration::from_secs(5), state.host_jobs.wait())
                .await
                .unwrap();
            assert!(paused(state.registry.lock().unwrap().find("chat").unwrap()));
            assert!(state.native_runtime.get().is_none());
            finish(state).await;
        }
    }
    #[tokio::test]
    async fn pre_driver_provider_failure_pauses_before_a_direct_reservation_is_released() {
        for code in [
            "network_denied",
            "start_unknown",
            "invalid_path",
            "unsupported_fork",
            "provider_unavailable",
            "unsupported",
        ] {
            let (_home, state, key) = fixture();
            state
                .registry
                .lock()
                .unwrap()
                .update_checked(&key, |r| {
                    r.remove("queuePaused");
                    Ok(())
                })
                .unwrap();
            {
                let mut c = state.session_commands.queue.control.lock().unwrap();
                c.direct.insert(key.clone());
                c.holds.insert(
                    (key.clone(), "a".into()),
                    ("fixture".into(), Instant::now() + HOLD),
                );
            }
            preparation_failed(state.clone(), key.clone(), code)
                .await
                .unwrap();
            assert!(
                paused(state.registry.lock().unwrap().find("chat").unwrap()),
                "pre-driver {code} released the queue without pausing"
            );
            assert!(
                state
                    .session_commands
                    .queue
                    .control
                    .lock()
                    .unwrap()
                    .direct
                    .contains(&key)
            );
            assert!(state.native_runtime.get().is_none());
            finish(state).await;
        }
    }
    #[tokio::test]
    async fn stale_incarnation_is_rejected_before_runtime_bootstrap_or_receipt() {
        let (_home, state, mut old) = fixture();
        old.created_at = "2020-01-01T00:00:00Z".into();
        let error = api::ordinary(
            state.clone(),
            json!({"name":"chat","text":"must not retarget"}),
            None,
            Default::default(),
            old,
            Arc::new(watch::channel(false).0),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "not_found");
        assert!(state.native_runtime.get().is_none());
        assert_eq!(
            state
                .last_event_id
                .load(std::sync::atomic::Ordering::Acquire),
            0
        );
        finish(state).await;
    }
}
