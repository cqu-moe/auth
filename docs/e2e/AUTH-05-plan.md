# AUTH-05 local implementation plan

The accepted workspace specification and AUTH-05 ticket remain authoritative. This is the ticket implementation record for the already approved to-spec → to-tickets → implement-spec workflow. AUTH-01/02 are present in the pinned base; AUTH-03/04 own school and device grant chains. No new tracker publication, shared execution change, push, PR or deployment is part of this branch.

## Observable acceptance and test ownership

| Journey | Behavior and credible regression | Primary observation | Why new coverage is needed |
| --- | --- | --- | --- |
| User administration | Strong administrator changes roles, bans/unbans a member; ordinary/weak identities and self ban cannot bypass guards | Built SPA actions, reopened management page, canonical user readback and actual member login | Existing AUTH-02 only reaches the admin gate; API/DO tests cannot catch the management form/transport integration |
| Ordinary administrator | Real strong admin can read and perform permitted administration but cannot grant superAdmin authority or mutate entitlements, clients, recovery or device quotas | UI and valid public HTTP requests with real strong and recent admin proofs; independent unchanged readback | Separates permission denial from missing authentication or malformed-body rejection |
| Invitations and entitlements | A UI-created preset/invitation affects a real new user's capabilities, revoke blocks registration, direct user grant/revoke persists | Management UI, actual registration/verification and user session capabilities | Does not reuse AUTH-01 policy permutations; owns management-origin writes and consumer effects |
| OAuth client configuration | UI creation/edit/secret rotation/delete affects the native provider's accepted callbacks and issued credentials | Reopened editor, public client inventory and real OAuth provider requests | Existing API tests do not prove the form writes the intended canonical configuration |
| Administrator device operations | Admin quota preview/apply uses real account DO; ordinary users cannot act on another user's sessions; permitted admin revocation affects only its target | Actual quota UI/public API and real session creation/list/revoke/readback | AUTH-04 owns full extension grants, device registration and school behavior; this test owns management permissions and session isolation |
| Manual account recovery | Real UI reset invalidates enrolled old factors, trust, sessions and outstanding credentials while a new password works and account/entitlements survive | Built settings/admin UI, native authentication endpoints, public readbacks | Low-level atomic/race tests remain; browser flow proves confirmation, step-up, one-time secret clearing and observable recovery |

These tests require no production exports, flags, schema or authentication bypass. Helpers may capture application-generated secrets in test-process memory and seed only registration prerequisites/initial administrator authority. No successful user, session, MFA proof, business entitlement, client or recovery result is inserted by fixtures. Only the Resend delivery boundary is replaced.

## Verification

Use fixed tester-army/e2e versions and AUTH-02's isolated per-journey runtime and secret scanner. Focused development runs precede two full ordinary-suite runs, each independently covering desktop and phone viewport. A deliberately wrong admin UI assertion must fail with nonzero inner exit and retained artifacts/cleanup. Run the repository's required original checks and E2E typecheck; report exact commands, first failures, final evidence and exclusions. Merge current integration into this ticket before the final validation/commit and preserve its platform hooks, mail objects and runners. Existing complete school suite is not repeated.
