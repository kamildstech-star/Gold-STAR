# Melly request external factors

These items cannot be completed by repository code or a reviewed database
migration alone. They are deliberately kept out of the implementation PR until
the named owner or provider input exists.

| Item                                                     | External input needed                                                       | Ready when                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Google review destinations                               | The Google Business Profile review URL for each office                      | Each office supplies and validates its own destination. The app now creates tracked redirect links from those URLs. |
| Microsoft 365 review and Outlook labels                  | Tenant admin consent, mailbox access, and the label names/behaviour to test | A Microsoft 365 administrator grants access and confirms the test mailbox.                                          |
| Phone workflow                                           | Choice of phone provider and provider credentials/webhook configuration     | The business selects the provider and supplies a test account.                                                      |
| Raven fleet freshness                                    | Live Raven delivery and valid Raven webhook credentials                     | Current vehicle positions arrive in the preview instead of the existing stale feed.                                 |
| Production map domain                                    | Google Maps key restrictions for the custom production hostname             | The hostname is added to the key allowlist and verified outside preview.                                            |
| Trade-show camera QA                                     | A physical iPad/iPhone with camera permission                               | A field user captures a selfie and voice note on the target device.                                                 |
| Client-health controls                                   | Melly's final health metrics, thresholds, and exact right-rail controls     | Product signs off on the metric definitions and control set.                                                        |
| Multi-office opportunities and construction/job pipeline | Ownership rules, stage definitions, and cross-office visibility decisions   | Product supplies the workflow and access matrix.                                                                    |

Review-link open counts are delivery signals, not proof that a human read or
submitted a Google review. Mail and chat services may prefetch links.
