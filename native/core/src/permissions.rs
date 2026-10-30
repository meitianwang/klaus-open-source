//! Permission observations and explicit consent requests.
//!
//! The passive probes never launch an application or present a dialog; the request
//! entry points exist only for the settings page's explicit "grant" button and return
//! the authorization status the system recorded after the user answered.

/// Apple Events has separate denied and not-yet-determined outcomes.
/// Process lookup failures and every unrecognized OS status prove neither grant nor denial.
pub fn automation_status_from_os_status(status: i32) -> &'static str {
    match status {
        0 => "granted",
        -1743 => "denied", // errAEEventNotPermitted
        _ => "unknown",    // Includes errAEEventWouldRequireUserConsent and procNotFound.
    }
}

/// PHAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 limited, 4 authorized.
/// Limited (pick-some) still lets the connector read chosen items, so it counts as granted.
pub fn photos_status_from_authorization(status: i32) -> &'static str {
    match status {
        3 | 4 => "granted",
        2 => "denied",
        _ => "unknown", // notDetermined, restricted, and unreadable framework states
    }
}

/// CLAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 authorizedAlways.
/// macOS has no while-in-use variant for background-less apps; always is the only grant.
pub fn location_status_from_authorization(status: i32) -> &'static str {
    match status {
        3 => "granted",
        1 | 2 => "denied",
        _ => "unknown",
    }
}

/// UNAuthorizationStatus: 0 notDetermined, 1 denied, 2 authorized, 3 provisional, 4 ephemeral.
/// Provisional and ephemeral deliver quietly without user-visible alerts, so they are
/// reported as unknown rather than granted: the settings row must not claim a grant the
/// user never saw a dialog for.
pub fn notification_status_from_authorization(status: i32) -> &'static str {
    match status {
        2 => "granted",
        1 => "denied",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        automation_status_from_os_status, location_status_from_authorization,
        notification_status_from_authorization, photos_status_from_authorization,
    };

    #[test]
    fn automation_status_preserves_the_committed_three_state_contract() {
        let contract: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/vectors/system-permission-vectors.json"
        ))
        .unwrap();
        for case in contract["automation"]["statusCases"].as_array().unwrap() {
            let actual =
                automation_status_from_os_status(case["osStatus"].as_i64().unwrap() as i32);
            assert_eq!(actual, case["status"].as_str().unwrap(), "{}", case["name"]);
        }
        for group in ["photos", "location", "notification"] {
            for case in contract[group]["statusCases"].as_array().unwrap() {
                let raw = case["authorizationStatus"].as_i64().unwrap() as i32;
                let actual = match group {
                    "photos" => photos_status_from_authorization(raw),
                    "location" => location_status_from_authorization(raw),
                    _ => notification_status_from_authorization(raw),
                };
                assert_eq!(actual, case["status"].as_str().unwrap(), "{} {}", group, case["name"]);
            }
        }
    }
}
