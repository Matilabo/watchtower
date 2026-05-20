/**
 * The operations the app actually sends.
 *
 * They live together, and away from the components, for two reasons: the
 * fragments stay shared so an alert always arrives with the same fields
 * whichever screen asked for it, and the mock server can be tested against the
 * exact documents production uses rather than against convenient one-offs.
 */

const RULE_HIT_FIELDS = `
  fragment RuleHitFields on RuleHit {
    rule
    kind
    title
    detail
    weight
    contribution
  }
`;

const ALERT_FIELDS = `
  fragment AlertFields on Alert {
    id
    watchEntryId
    watchedDomain
    triage
    firstSeenAt
    lastSeenAt
    certificate {
      id
      names
      commonName
      issuer
      loggedAt
      notBefore
      notAfter
      serialNumber
      source
    }
    assessment {
      candidate
      candidateAscii
      candidateUnicode
      watched
      matchedLabel
      score
      level
      benign
      summary
      hits {
        ...RuleHitFields
      }
    }
    history {
      state
      at
      note
    }
  }
  ${RULE_HIT_FIELDS}
`;

export const WATCHLIST_QUERY = `
  query Watchlist {
    watchlist {
      id
      domain
      canonicalDomain
      label
      createdAt
      alertCount
    }
  }
`;

export const ALERTS_QUERY = `
  query Alerts($state: TriageState, $minScore: Int, $watchEntryId: ID) {
    alerts(state: $state, minScore: $minScore, watchEntryId: $watchEntryId) {
      ...AlertFields
    }
  }
  ${ALERT_FIELDS}
`;

export const ALERT_SUMMARY_QUERY = `
  query AlertSummary {
    alertSummary {
      total
      new
      investigating
      benign
      malicious
      unresolvedHighRisk
    }
  }
`;

export const ADD_WATCHLIST_ENTRY_MUTATION = `
  mutation AddWatchlistEntry($input: AddWatchlistEntryInput!) {
    addWatchlistEntry(input: $input) {
      entry {
        id
        domain
        canonicalDomain
        label
        createdAt
        alertCount
      }
      error {
        message
        field
      }
    }
  }
`;

export const REMOVE_WATCHLIST_ENTRY_MUTATION = `
  mutation RemoveWatchlistEntry($id: ID!) {
    removeWatchlistEntry(id: $id)
  }
`;

export const RECORD_ALERTS_MUTATION = `
  mutation RecordAlerts($input: [RecordAlertInput!]!) {
    recordAlerts(input: $input) {
      created {
        ...AlertFields
      }
      updated {
        ...AlertFields
      }
      error {
        message
        field
      }
    }
  }
  ${ALERT_FIELDS}
`;

export const SET_TRIAGE_STATE_MUTATION = `
  mutation SetTriageState($input: SetTriageStateInput!) {
    setTriageState(input: $input) {
      alert {
        ...AlertFields
      }
      error {
        message
        field
      }
    }
  }
  ${ALERT_FIELDS}
`;
