//! Fixed parity cases from test/access.test.ts and server.ts checkFull/accessGate.
use pult_core::host_policy::*;
use pult_core::turn_snapshot::{Approval, Provider};

fn facts(provider: Provider, desired: Approval) -> AccessFacts {
    AccessFacts {
        provider,
        desired,
        effective_inherit_mode: None,
        inherit_seen: None,
        session_grant: None,
        consent: Consent::default(),
    }
}
fn consent() -> Consent {
    Consent {
        version: 1,
        rev: 1,
        providers: vec![Provider::Claude, Provider::Codex, Provider::Zcode],
        has_valid_granted_at: true,
        has_valid_revoked_at: false,
    }
}
fn selection() -> SelectionConfirmation {
    SelectionConfirmation {
        confirm: true,
        consent_rev: None,
        requested_grant: None,
        client: ClientKind::Other,
    }
}
#[test]
fn consent_requires_current_version_valid_grant_and_no_revocation() {
    let mut c = consent();
    assert!(c.covers(Provider::Claude));
    c.version = 2;
    assert!(c.covers(Provider::Claude));
    c.version = 0;
    assert!(!c.covers(Provider::Claude));
    c.version = 1;
    c.has_valid_granted_at = false;
    assert!(!c.covers(Provider::Claude));
    c.has_valid_granted_at = true;
    c.has_valid_revoked_at = true;
    assert!(!c.covers(Provider::Claude));
}
#[test]
fn old_two_provider_consent_does_not_cover_zcode() {
    let mut c = consent();
    c.providers = vec![Provider::Claude, Provider::Codex];
    assert!(c.covers(Provider::Claude));
    assert!(!c.covers(Provider::Zcode));
}
#[test]
fn unapproved_full_downgrades_every_provider_to_explicit_ask() {
    for p in [Provider::Claude, Provider::Codex, Provider::Zcode] {
        let result = effective_access(&facts(p, Approval::Full));
        assert_eq!(result.effective, Approval::Ask);
        assert_eq!(result.notice.unwrap().reason, DowngradeReason::NotGranted);
    }
}
#[test]
fn approved_full_stays_full() {
    let mut f = facts(Provider::Claude, Approval::Full);
    f.consent = consent();
    assert_eq!(
        effective_access(&f),
        AccessDecision {
            effective: Approval::Full,
            notice: None
        }
    );
}
#[test]
fn revocation_changes_notice_key_and_preserves_desired() {
    let mut f = facts(Provider::Claude, Approval::Full);
    let before = effective_access(&f).notice.unwrap();
    f.consent.rev = 2;
    f.consent.has_valid_revoked_at = true;
    let after = effective_access(&f).notice.unwrap();
    assert_eq!(after.reason, DowngradeReason::Revoked);
    assert_ne!(before, after);
    assert_eq!(after.desired, Approval::Full);
    assert_eq!(after.consent_rev, 2);
    assert_eq!(after, effective_access(&f).notice.unwrap());
}
#[test]
fn unknown_or_nonfull_inherit_stays_inherit() {
    let mut f = facts(Provider::Claude, Approval::Inherit);
    assert_eq!(effective_access(&f).effective, Approval::Inherit);
    f.effective_inherit_mode = Some("acceptEdits".into());
    assert_eq!(effective_access(&f).effective, Approval::Inherit);
}
#[test]
fn observed_bypass_overrides_nonfull_settings_prediction() {
    let mut f = facts(Provider::Claude, Approval::Inherit);
    f.effective_inherit_mode = Some("default".into());
    f.inherit_seen = Some("bypassPermissions".into());
    assert_eq!(effective_access(&f).effective, Approval::Ask);
    assert_eq!(
        effective_access(&f).notice.unwrap().reason,
        DowngradeReason::InheritedBypass
    );
    f.consent = consent();
    assert_eq!(effective_access(&f).effective, Approval::Inherit);
}
#[test]
fn predicted_bypass_remains_full_despite_other_observed_mode() {
    let mut f = facts(Provider::Claude, Approval::Inherit);
    f.effective_inherit_mode = Some("bypassPermissions".into());
    f.inherit_seen = Some("default".into());
    assert_eq!(effective_access(&f).effective, Approval::Ask);
}
#[test]
fn explicit_nonfull_modes_ignore_inherited_bypass() {
    for a in [Approval::ReadOnly, Approval::Ask, Approval::Workspace] {
        let mut f = facts(Provider::Claude, a);
        f.effective_inherit_mode = Some("bypassPermissions".into());
        assert_eq!(
            effective_access(&f),
            AccessDecision {
                effective: a,
                notice: None
            }
        );
    }
}
#[test]
fn session_cli_grant_survives_multiple_turns_and_global_revocation() {
    let mut f = facts(Provider::Claude, Approval::Full);
    f.session_grant = Some(SessionGrant::CliOnce);
    f.consent.has_valid_revoked_at = true;
    for _ in 0..2 {
        assert_eq!(effective_access(&f).effective, Approval::Full);
    }
}
#[test]
fn full_selection_needs_confirm_even_with_consent_or_cli_grant() {
    let mut f = facts(Provider::Claude, Approval::Full);
    f.consent = consent();
    let mut s = selection();
    s.confirm = false;
    assert_eq!(
        validate_full_selection(&f, s),
        Err(PolicyError::InvalidParams)
    );
    s.requested_grant = Some(SessionGrant::CliOnce);
    assert_eq!(
        validate_full_selection(&f, s),
        Err(PolicyError::InvalidParams)
    );
}
#[test]
fn full_selection_checks_stale_revision_before_coverage() {
    let f = facts(Provider::Claude, Approval::Full);
    let mut s = selection();
    s.consent_rev = Some(1);
    assert_eq!(
        validate_full_selection(&f, s),
        Err(PolicyError::ConsentChanged)
    );
    s.consent_rev = Some(0);
    assert_eq!(
        validate_full_selection(&f, s),
        Err(PolicyError::ConsentRequired)
    );
}
#[test]
fn valid_full_selection_accepts_current_or_omitted_revision() {
    let mut f = facts(Provider::Claude, Approval::Full);
    f.consent = consent();
    let mut s = selection();
    assert_eq!(validate_full_selection(&f, s), Ok(None));
    s.consent_rev = Some(1);
    assert_eq!(validate_full_selection(&f, s), Ok(None));
    s.consent_rev = Some(0);
    assert_eq!(
        validate_full_selection(&f, s),
        Err(PolicyError::ConsentChanged)
    );
}
#[test]
fn cli_request_grant_bypasses_stale_revision_and_consent() {
    let f = facts(Provider::Claude, Approval::Full);
    let mut s = selection();
    s.requested_grant = Some(SessionGrant::CliOnce);
    s.consent_rev = Some(100);
    assert_eq!(
        validate_full_selection(&f, s),
        Ok(Some(SessionGrant::CliOnce))
    );
}
#[test]
fn shell_cannot_request_cli_grant_even_for_nonfull_mode() {
    let mut s = selection();
    s.client = ClientKind::Shell;
    s.requested_grant = Some(SessionGrant::CliOnce);
    for a in [Approval::Ask, Approval::Full] {
        assert_eq!(
            validate_full_selection(&facts(Provider::Claude, a), s),
            Err(PolicyError::Forbidden)
        );
    }
    assert_eq!(PolicyError::Forbidden.code(), "forbidden");
    assert_eq!(validate_selection_source(s), Err(PolicyError::Forbidden));
}
#[test]
fn configure_noop_always_checks_source_and_cannot_install_new_cli_grant() {
    let mut f = facts(Provider::Claude, Approval::Full);
    f.consent = consent();
    let mut s = selection();
    s.confirm = false;
    s.requested_grant = Some(SessionGrant::CliOnce);
    // Non-shell no-op ignores the request grant, rather than making global
    // consent revocation ineffective for this session later.
    let granted = validate_configure_selection(&f, Some(&f), s).unwrap();
    assert_eq!(granted, None);
    assert_eq!(
        session_grant_after_selection(f.desired, None, Some(f.desired), granted),
        None
    );
    s.client = ClientKind::Shell;
    assert_eq!(
        validate_configure_selection(&f, Some(&f), s),
        Err(PolicyError::Forbidden)
    );
    assert_eq!(
        validate_configure_selection(&f, None, s),
        Err(PolicyError::Forbidden)
    );
    s.client = ClientKind::Other;
    f.consent = Consent::default();
    assert_eq!(
        validate_configure_selection(&f, Some(&f), s),
        Err(PolicyError::InvalidParams)
    );
    s.confirm = true;
    assert_eq!(
        validate_configure_selection(&f, Some(&f), s),
        Ok(Some(SessionGrant::CliOnce))
    );
}
#[test]
fn inherited_full_without_confirm_accepts_consent_and_ignores_stale_rev() {
    let mut f = facts(Provider::Claude, Approval::Inherit);
    f.effective_inherit_mode = Some("bypassPermissions".into());
    let mut s = selection();
    s.confirm = false;
    s.consent_rev = Some(99);
    assert_eq!(
        validate_full_selection(&f, s),
        Err(PolicyError::ConsentRequired)
    );
    f.consent = consent();
    assert_eq!(validate_full_selection(&f, s), Ok(None));
    s.confirm = true;
    assert_eq!(
        validate_full_selection(&f, s),
        Err(PolicyError::ConsentChanged)
    );
}
#[test]
fn existing_session_grant_is_not_a_fresh_selection_confirmation() {
    let mut f = facts(Provider::Claude, Approval::Full);
    f.session_grant = Some(SessionGrant::CliOnce);
    assert_eq!(
        validate_full_selection(&f, selection()),
        Err(PolicyError::ConsentRequired)
    );
}
#[test]
fn inherit_selection_only_exists_for_claude() {
    for p in [Provider::Codex, Provider::Zcode] {
        assert_eq!(
            validate_full_selection(&facts(p, Approval::Inherit), selection()),
            Err(PolicyError::InvalidParams)
        );
    }
}
#[test]
fn grant_lifetime_follows_explicit_approval_selection() {
    let g = Some(SessionGrant::CliOnce);
    assert_eq!(
        session_grant_after_selection(Approval::Full, g, None, None),
        g
    );
    assert_eq!(
        session_grant_after_selection(Approval::Full, g, Some(Approval::Full), None),
        g
    );
    assert_eq!(
        session_grant_after_selection(Approval::Full, g, Some(Approval::Ask), None),
        None
    );
    assert_eq!(
        session_grant_after_selection(Approval::Full, g, Some(Approval::Inherit), None),
        None
    );
    assert_eq!(
        session_grant_after_selection(Approval::Full, None, Some(Approval::Full), g),
        g
    );
    assert_eq!(
        session_grant_after_selection(Approval::Ask, None, Some(Approval::Full), g),
        g
    );
}

#[test]
fn invalid_inherit_provider_is_rejected_even_when_configure_looks_like_a_noop() {
    for provider in [Provider::Codex, Provider::Zcode] {
        let f = facts(provider, Approval::Inherit);
        assert_eq!(validate_configure_selection(&f, Some(&f), selection()), Err(PolicyError::InvalidParams));
    }
}
