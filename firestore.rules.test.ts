/**
 * Phase 0 / Phase 5 Security Rules Verification Suite (Dirty Dozen Payloads)
 *
 * Designed for execution against the Firebase Firestore Rules Emulator via
 * `@firebase/rules-unit-testing` and verified structurally alongside ESLint
 * `@firebase/eslint-plugin-security-rules`.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; email?: string; email_verified?: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
  enforcedBy: string;
}

export const DIRTY_DOZEN_CASES: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Root Read',
    operation: 'get',
    path: '/users/alice',
    auth: null,
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isOwner(userId)',
  },
  {
    id: 2,
    name: 'Cross-User PII Read',
    operation: 'get',
    path: '/users/alice',
    auth: { uid: 'bob', email: 'bob@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isOwner(userId)',
  },
  {
    id: 3,
    name: 'Unverified Email Write',
    operation: 'create',
    path: '/users/alice',
    auth: { uid: 'alice', email: 'alice@example.com', email_verified: false },
    payload: { uid: 'alice', email: 'alice@example.com' },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isVerifiedOwner(userId)',
  },
  {
    id: 4,
    name: 'Shadow Field Injection on User Create',
    operation: 'create',
    path: '/users/alice',
    auth: { uid: 'alice', email: 'alice@example.com', email_verified: true },
    payload: { uid: 'alice', isAdmin: true, role: 'superadmin' },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isValidUserAccount -> hasOnly(...)',
  },
  {
    id: 5,
    name: 'Plaintext Password Injection on IPTV Account',
    operation: 'create',
    path: '/users/alice/iptvAccounts/pl_1',
    auth: { uid: 'alice', email: 'alice@example.com', email_verified: true },
    payload: {
      id: 'pl_1',
      ownerId: 'alice',
      name: 'Provider',
      type: 'xtream',
      password: 'plaintext_secret_must_be_rejected',
    },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isValidIptvAccount -> hasOnly(...) forbids plaintext password',
  },
  {
    id: 6,
    name: 'Owner Spoofing on IPTV Account',
    operation: 'create',
    path: '/users/alice/iptvAccounts/pl_1',
    auth: { uid: 'alice', email: 'alice@example.com', email_verified: true },
    payload: { id: 'pl_1', ownerId: 'bob', name: 'Spoofed' },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isValidIptvAccount -> data.ownerId == request.auth.uid',
  },
  {
    id: 7,
    name: 'Client Timestamp Forgery',
    operation: 'create',
    path: '/users/alice/profiles/profile_1',
    auth: { uid: 'alice', email: 'alice@example.com', email_verified: true },
    payload: { id: 'profile_1', ownerId: 'alice', createdAt: '2020-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'incoming().createdAt == request.time',
  },
  {
    id: 8,
    name: 'Immutable Field Tampering on Profile Update',
    operation: 'update',
    path: '/users/alice/profiles/profile_1',
    auth: { uid: 'alice', email: 'alice@example.com', email_verified: true },
    payload: { ownerId: 'bob', createdAt: '2025-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'incoming().ownerId == existing().ownerId && affectedKeys().hasOnly(...)',
  },
  {
    id: 9,
    name: 'ID Poisoning via Oversized or Malformed Document ID',
    operation: 'create',
    path: '/users/alice/iptvAccounts/bad$id..injection',
    auth: { uid: 'alice', email: 'alice@example.com', email_verified: true },
    payload: { id: 'bad$id..injection', ownerId: 'alice' },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isValidId(accountId)',
  },
  {
    id: 10,
    name: 'Denial-of-Wallet Value Poisoning (Oversized Profile Name)',
    operation: 'update',
    path: '/users/alice/profiles/profile_1',
    auth: { uid: 'alice', email: 'alice@example.com', email_verified: true },
    payload: { name: 'A'.repeat(5000) },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isValidProfile -> data.name.size() <= 40',
  },
  {
    id: 11,
    name: 'Orphaned Subcollection Write Without Parent Profile',
    operation: 'create',
    path: '/users/alice/profiles/nonexistent_profile/watchHistory/m1',
    auth: { uid: 'alice', email: 'alice@example.com', email_verified: true },
    payload: { itemId: 'm1', profileId: 'nonexistent_profile', ownerId: 'alice' },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'profileDocExistsOrCreated(userId, profileId)',
  },
  {
    id: 12,
    name: 'Cross-User Watch History List Scraping',
    operation: 'list',
    path: '/users/alice/profiles/profile_1/watchHistory',
    auth: { uid: 'bob', email: 'bob@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
    enforcedBy: 'isOwner(userId) && resource.data.ownerId == request.auth.uid',
  },
];
