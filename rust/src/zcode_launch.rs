//! Pure current Node ZCode Route A argv/context and explicit config environment.
//! No executable discovery, filesystem/account reads, MCP, subprocess or network.
use crate::{turn_snapshot::Approval, worker_env::Environment};
use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    Capacity,
}
pub const ENV_PASS: [&str; 7] = [
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_BASE_URL",
    "ZCODE_ENDPOINT_ORIGIN",
    "ZCODE_PRODUCTION_BASE_URL",
    "ZCODE_TEST_BASE_URL",
    "ZCODE_APP_VERSION",
];
/// Provider metadata remains accepted, but Route A has no model/effort flags.
/// Deliberately no Debug: prompt, config environment and paths may be private.
pub struct Options<'a> {
    pub prompt: &'a str,
    pub cwd: &'a str,
    pub resume_session_id: Option<&'a str>,
    pub approval: Approval,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
}
pub fn mode(approval: Approval) -> &'static str {
    match approval {
        Approval::ReadOnly => "plan",
        Approval::Ask | Approval::Inherit => "guarded",
        Approval::Workspace => "edit",
        Approval::Full => "yolo",
    }
}
/// Pure legacy inherit fallback matches Node; host TurnSettings must reject
/// inherit for ZCode before dispatch. No permission is granted by this builder.
pub fn argv(options: &Options<'_>) -> Result<Vec<String>, Error> {
    if !options.cwd.starts_with('/')
        || [options.prompt, options.cwd]
            .iter()
            .any(|v| v.contains('\0'))
        || options
            .resume_session_id
            .is_some_and(|id| id.contains('\0'))
    {
        return Err(Error::Invalid);
    }
    if [options.prompt, options.cwd]
        .iter()
        .any(|v| v.len() > 65536)
        || options
            .resume_session_id
            .is_some_and(|id| id.encode_utf16().count() > 512)
    {
        return Err(Error::Capacity);
    }
    let mut args = vec![
        "-p".into(),
        options.prompt.into(),
        "--cwd".into(),
        options.cwd.into(),
        "--surface".into(),
        "terminal".into(),
        "--mode".into(),
        mode(options.approval).into(),
        "--output-format".into(),
        "stream-json".into(),
    ];
    if let Some(id) = options.resume_session_id.filter(|id| !id.is_empty()) {
        args.extend(["--resume".into(), id.into()]);
    }
    Ok(args)
}
/// Extract before BASE filtering. Does not copy BASE/proxy/credentials; callers
/// combine these approved host values with the selected NetworkGuard route.
pub fn extra_env(parent: &Environment) -> Result<Environment, Error> {
    let mut out = Environment::new();
    let mut bytes = 0usize;
    for name in ENV_PASS {
        if let Some(value) = parent.get(OsStr::new(name)).filter(|v| !v.is_empty()) {
            if value.as_bytes().contains(&0) {
                return Err(Error::Invalid);
            }
            bytes = bytes
                .checked_add(name.len() + value.len() + 2)
                .ok_or(Error::Capacity)?;
            if bytes > 65536 {
                return Err(Error::Capacity);
            }
            out.insert(name.into(), value.clone());
        }
    }
    Ok(out)
}
/// Exact current Node RU approvalContext('zcode', approval, broker). Pure model
/// explanation, never authority. No pa_/mt_ issuance or Inbox promise is added.
pub fn approval_context(approval: Approval, broker: bool) -> String {
    approval_context_language(approval, broker, ContextLanguage::Ru)
}
#[derive(Clone, Copy, Debug)]
pub enum ContextLanguage {
    Ru,
    En,
}
/// Mirrors Node's translated APPROVAL_WORDS label. The surrounding context
/// literals are Russian in current Node even in an English request context.
pub fn approval_context_language(
    approval: Approval,
    broker: bool,
    language: ContextLanguage,
) -> String {
    let title = match (language, approval) {
        (ContextLanguage::En, Approval::ReadOnly) => "Read only",
        (ContextLanguage::En, Approval::Ask) => "Ask",
        (ContextLanguage::En, Approval::Workspace) => "Edit project files without asking",
        (ContextLanguage::En, Approval::Full) => "Full access",
        (ContextLanguage::En, Approval::Inherit) => "As in Claude settings",
        (ContextLanguage::Ru, approval) => match approval {
            Approval::ReadOnly => "Только чтение",
            Approval::Ask => "Спрашивать",
            Approval::Workspace => "Правки в папке без вопросов",
            Approval::Full => "Полный доступ",
            Approval::Inherit => "Как в настройках Claude",
        },
    };
    let mut lines = vec![
        "<pult_runtime_context>".into(),
        format!(
            "Контекст Пульта для этого хода: провайдер zcode; выбран режим «{title}» ({}). При смене режима ориентируйся на контекст текущего хода и действующие ограничения инструментов.",
            approval.as_str()
        ),
        format!("ZCode: --mode={}.", mode(approval)),
    ];
    match approval {
        Approval::ReadOnly=>lines.push("Режим plan: только чтение и планирование, правки файлов недоступны.".into()),
        Approval::Ask=>lines.push("Режим «Спрашивать» у ZCode работает как guarded: безопасные действия выполняются сами, распознанно опасные (rm -rf, force push и подобные) отклоняются автоматически. Вопросов человеку в Inbox Пульт отсюда не приходит — объясняй ограничения в ответе, подтверждение в тексте чата не заменяет разрешение.".into()),
        Approval::Workspace=>lines.push("Правки файлов применяются автоматически; остальное — по правилам самого ZCode.".into()),_=>{}
    }
    lines.push("Брокер разрешений Пульта к этому CLI не подключён: там, где нужен вопрос человеку, объясни причину и предложи сменить режим сессии или выполнить шаг самому.".into());
    if !broker {
        lines.push("Сейчас брокер разрешений недоступен: действия, требующие подтверждения, отклоняются. Объясни это пользователю; подтверждение в тексте чата не заменяет разрешение инструмента.".into());
    }
    if approval == Approval::Full {
        lines.push("Пульт не ставит свою песочницу или запросы разрешений в этом режиме. Это не гарантирует доступ к сети, Keychain, учётной записи или ресурсам ОС.".into());
    }
    lines.push("При отказе доступа или ответе вложенной CLI «Not logged in» сначала различай ограничения текущего процесса и состояние входа пользователя. Сообщай наблюдаемый факт и источник ограничения; такой ответ сам по себе не доказывает, что пользователь вышел из аккаунта. Повторный вход предлагай после подтверждения проблемы авторизации вне ограниченного процесса.".into());
    lines.push("</pult_runtime_context>".into());
    lines.join("\n")
}
