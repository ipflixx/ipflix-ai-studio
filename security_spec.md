# IPFLIX Cloud Sync — Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Strict Ownership Isolation**: Every document under `/users/{userId}` and all nested subcollections (`iptvAccounts`, `profiles`, `listItems`, `watchHistory`) is exclusively readable and writable by the authenticated user whose `request.auth.uid == userId`. No blanket `isSignedIn()` reads or cross-user reads exist anywhere.
2. **Verified Identity Gate**: Every write operation mandates `request.auth != null && request.auth.token.email_verified == true`.
3. **Master Gate Relational Integrity**: Every subcollection write (`iptvAccounts`, `profiles`, `listItems`, `watchHistory`) verifies parent existence (`exists(/databases/$(database)/documents/users/$(userId))`, and for profile subcollections also verifies parent profile exists and belongs to `userId`).
4. **Zero-Plaintext IPTV Secrets**: `IptvAccount` only permits encrypted ciphertext in `encryptedCredentials` (max 8192 bytes) and `UserProfile` only permits encrypted ciphertext in `encryptedPin` (max 512 bytes). Plaintext `password`, `m3uUrl`, `epgUrl`, or `pin` fields are rejected by strict `hasOnly(...)` schema allowlists.
5. **Immutable Identity & Temporal Integrity**: `uid`, `ownerId`, `id`, `profileId`, and `createdAt` are immutable after creation. `createdAt == request.time` on create; `updatedAt == request.time` on create and update.
6. **Zero Unbounded Arrays**: All favorites, watchlists, hidden channels, recent channels, and watch progress items live in dedicated per-profile subcollections rather than arrays inside parent documents.
7. **Strict Path & Field Sizing**: All document IDs match `^[a-zA-Z0-9_\-]+$` (<= 128 chars) on single-doc operations, and every string/number has explicit upper and lower bounds.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Return `PERMISSION_DENIED`)
1. **Unauthenticated Root Read**: Unauthenticated `get(/users/alice)` — rejected by `isOwner(userId)`.
2. **Cross-User PII Read**: Authenticated `bob` attempting `get(/users/alice)` — rejected by `isOwner(userId)`.
3. **Unverified Email Write**: Authenticated `alice` with `email_verified: false` creating `/users/alice` — rejected by `isVerifiedOwner(userId)`.
4. **Shadow Field Injection on User Create**: Creating `/users/alice` with ghost field `isAdmin: true` or `role: "admin"` — rejected by `data.keys().hasOnly(...)`.
5. **Plaintext Password Injection on IPTV Account**: Creating `/users/alice/iptvAccounts/pl_1` with disallowed key `password: "secret123"` — rejected by `isValidIptvAccount`.
6. **Owner Spoofing on IPTV Account**: Authenticated `alice` creating `/users/alice/iptvAccounts/pl_1` with `ownerId: "bob"` — rejected by `data.ownerId == request.auth.uid`.
7. **Client Timestamp Forgery**: Creating `/users/alice/profiles/p1` with `createdAt` forged to a past date instead of `request.time` — rejected by `incoming().createdAt == request.time`.
8. **Immutable Field Tampering on Update**: Updating `/users/alice/profiles/p1` while mutating `createdAt` or `ownerId` — rejected by immutability guards and `affectedKeys().hasOnly(...)`.
9. **ID Poisoning**: Creating `/users/alice/iptvAccounts/../../evil$id` or a 200-char ID — rejected by `isValidId(accountId)`.
10. **Denial-of-Wallet String Overflow**: Updating `/users/alice/profiles/p1` with a 5,000-character `name` or 1MB `encryptedPin` — rejected by `isValidProfile(incoming())` size guards.
11. **Orphaned Subcollection Write**: Creating `/users/alice/profiles/nonexistent/watchHistory/m1` when parent profile does not exist — rejected by Master Gate `exists(...)`.
12. **Cross-User List Scraping**: Authenticated `bob` running `list` on `/users/alice/profiles/p1/watchHistory` — rejected by `isOwner(userId) && resource.data.ownerId == request.auth.uid`.
