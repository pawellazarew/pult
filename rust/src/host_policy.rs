//! Pure access policy, not an authorization boundary or permission to start a worker.
//! The host must refresh consent/settings and rerun guards before spawn/send.
use crate::turn_snapshot::{Approval, Provider};

pub const CONSENT_VERSION: u64 = 1;

/// Facts after the host's consent parser has validated dates and safe integers.
/// This module deliberately does not parse dates or read/write consent.json.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Consent {
    pub version: u64,
    pub rev: u64,
    pub providers: Vec<Provider>,
    pub has_valid_granted_at: bool,
    pub has_valid_revoked_at: bool,
}

impl Consent {
    pub fn covers(&self, provider: Provider) -> bool {
        self.version >= CONSENT_VERSION
            && self.has_valid_granted_at
            && !self.has_valid_revoked_at
            && self.providers.contains(&provider)
    }
}

/// Legacy wire spelling `cli-once`: persists for the session, not one turn.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionGrant {
    CliOnce,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccessFacts {
    pub provider: Provider,
    pub desired: Approval,
    pub effective_inherit_mode: Option<String>,
    pub inherit_seen: Option<String>,
    pub session_grant: Option<SessionGrant>,
    pub consent: Consent,
}

impl AccessFacts {
    pub fn desired_is_full(&self) -> bool {
        self.desired == Approval::Full
            || (self.provider == Provider::Claude
                && self.desired == Approval::Inherit
                && (self.inherit_seen.as_deref() == Some("bypassPermissions")
                    || self.effective_inherit_mode.as_deref() == Some("bypassPermissions")))
    }

    pub fn full_allowed(&self) -> bool {
        self.session_grant == Some(SessionGrant::CliOnce) || self.consent.covers(self.provider)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DowngradeReason {
    InheritedBypass,
    Revoked,
    NotGranted,
}

/// Host deduplicates this key per session; an allowed decision clears that key.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DowngradeNotice {
    pub desired: Approval,
    pub consent_rev: u64,
    pub reason: DowngradeReason,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AccessDecision {
    pub effective: Approval,
    pub notice: Option<DowngradeNotice>,
}

pub fn effective_access(facts: &AccessFacts) -> AccessDecision {
    if !facts.desired_is_full() || facts.full_allowed() {
        return AccessDecision {
            effective: facts.desired,
            notice: None,
        };
    }
    AccessDecision {
        // Explicit Ask: never translate this to provider inherit/no-flag mode.
        effective: Approval::Ask,
        notice: Some(DowngradeNotice {
            desired: facts.desired,
            consent_rev: facts.consent.rev,
            reason: if facts.desired == Approval::Inherit {
                DowngradeReason::InheritedBypass
            } else if facts.consent.has_valid_revoked_at {
                DowngradeReason::Revoked
            } else {
                DowngradeReason::NotGranted
            },
        }),
    }
}

/// Node only singles out the self-reported shell client. Other is not an
/// authenticated identity; this policy protects against mistakes/stale UI.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClientKind {
    Shell,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SelectionConfirmation {
    pub confirm: bool,
    pub consent_rev: Option<u64>,
    pub requested_grant: Option<SessionGrant>,
    pub client: ClientKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyError {
    InvalidParams,
    Forbidden,
    ConsentRequired,
    ConsentChanged,
}

impl PolicyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidParams => "invalid_params",
            Self::Forbidden => "forbidden",
            Self::ConsentRequired => "consent_required",
            Self::ConsentChanged => "consent_changed",
        }
    }
}

/// Unconditional source check: Node runs this even for configure no-ops and
/// requests that do not select an approval mode.
pub fn validate_selection_source(selection: SelectionConfirmation) -> Result<(), PolicyError> {
    if selection.client == ClientKind::Shell && selection.requested_grant.is_some() {
        return Err(PolicyError::Forbidden);
    }
    Ok(())
}

/// Start/fresh selection checks. Existing session grants intentionally do not
/// authorize a fresh Full selection: Node's checkFull checks the request.
/// Configure callers should use validate_configure_selection instead so the
/// unconditional source check cannot be skipped on an already-allowed no-op.
pub fn validate_full_selection(
    facts: &AccessFacts,
    selection: SelectionConfirmation,
) -> Result<Option<SessionGrant>, PolicyError> {
    validate_selection_source(selection)?;
    if facts.desired == Approval::Inherit && facts.provider != Provider::Claude {
        return Err(PolicyError::InvalidParams);
    }
    if !facts.desired_is_full() {
        return Ok(None);
    }
    if !selection.confirm {
        return if facts.desired == Approval::Inherit {
            if facts.consent.covers(facts.provider) {
                Ok(None)
            } else {
                Err(PolicyError::ConsentRequired)
            }
        } else {
            Err(PolicyError::InvalidParams)
        };
    }
    if selection.requested_grant == Some(SessionGrant::CliOnce) {
        return Ok(selection.requested_grant);
    }
    if selection
        .consent_rev
        .is_some_and(|rev| rev != facts.consent.rev)
    {
        return Err(PolicyError::ConsentChanged);
    }
    if !facts.consent.covers(facts.provider) {
        return Err(PolicyError::ConsentRequired);
    }
    Ok(None)
}

/// Node configure checks the source first, then skips checkFull for an already
/// allowed no-op. Such a no-op does NOT install a requested CLI grant: return
/// None, preserving only a grant already on the session. For an actual switch
/// to Inherit the host supplies fresh selected facts without old inheritSeen.
pub fn validate_configure_selection(
    current: &AccessFacts,
    selected: Option<&AccessFacts>,
    selection: SelectionConfirmation,
) -> Result<Option<SessionGrant>, PolicyError> {
    validate_selection_source(selection)?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    if selected.provider != current.provider
        || (selected.desired == Approval::Inherit && selected.provider != Provider::Claude)
    {
        return Err(PolicyError::InvalidParams);
    }
    let blocked_now = current.desired_is_full() && !current.full_allowed();
    if selected.desired == current.desired && !blocked_now {
        return Ok(None);
    }
    validate_full_selection(selected, selection)
}

/// Apply only after selection validation. An actual approval change clears the
/// previous grant; explicitly reselecting Full/Inherit can add a fresh grant.
pub fn session_grant_after_selection(
    previous: Approval,
    previous_grant: Option<SessionGrant>,
    selected: Option<Approval>,
    validated_request_grant: Option<SessionGrant>,
) -> Option<SessionGrant> {
    let Some(next) = selected else {
        return previous_grant;
    };
    let requested = if matches!(next, Approval::Full | Approval::Inherit) {
        validated_request_grant
    } else {
        None
    };
    if previous != next {
        requested
    } else {
        requested.or(previous_grant)
    }
}
