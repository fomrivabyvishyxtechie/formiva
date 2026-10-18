import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const clerkMock = vi.hoisted(() => ({
  createClerkClient: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@clerk/backend', () => ({
  createClerkClient: clerkMock.createClerkClient,
}));

import {
  createIdentityLookup,
  syncUserIdentity,
  type ClerkUserLookup,
} from '../src/services/identity';

describe('trusted Clerk identity projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clerkMock.createClerkClient.mockReturnValue({ users: { getUser: clerkMock.getUser } });
  });

  it('requires the server-side secret without creating a Clerk client', () => {
    expect(() => createIdentityLookup('')).toThrow('CLERK_SECRET_KEY');
    expect(clerkMock.createClerkClient).not.toHaveBeenCalled();
  });

  it('uses createClerkClient with the server-side secret', () => {
    const lookup = createIdentityLookup('sk_test_mocked');

    expect(clerkMock.createClerkClient).toHaveBeenCalledWith({ secretKey: 'sk_test_mocked' });
    expect(lookup.users.getUser).toBe(clerkMock.getUser);
  });

  it('normalizes the primary verified Clerk email before persistence', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const clerk: ClerkUserLookup = {
      users: {
        getUser: vi.fn().mockResolvedValue({
          primaryEmailAddressId: 'email_1',
          updatedAt: Date.now(),
          firstName: 'Ada',
          lastName: 'Lovelace',
          banned: false,
          locked: false,
          emailAddresses: [
            {
              id: 'email_1',
              emailAddress: ' Ada@Example.Test ',
              verification: { status: 'verified' },
            },
          ],
        }),
      },
    };

    await syncUserIdentity({ query } as unknown as Pool, 'user_1', clerk);

    expect(query).toHaveBeenCalledWith('SELECT app.sync_user_identity($1, $2, $3, $4, $5)', [
      'user_1',
      'ada@example.test',
      'Ada Lovelace',
      true,
      expect.any(Date),
    ]);
  });

  it('fails closed for missing, unverified, or stale provider identity', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const clerk: ClerkUserLookup = {
      users: {
        getUser: vi.fn().mockResolvedValue({
          primaryEmailAddressId: 'email_1',
          updatedAt: null,
          firstName: null,
          lastName: null,
          banned: false,
          locked: false,
          emailAddresses: [
            {
              id: 'email_1',
              emailAddress: 'ada@example.test',
              verification: { status: 'unverified' },
            },
          ],
        }),
      },
    };

    await syncUserIdentity({ query } as unknown as Pool, 'user_1', clerk);

    expect(query.mock.calls[0]?.[1]).toEqual(['user_1', 'ada@example.test', null, false, null]);
  });

  it('does not use a non-primary or absent email as trusted identity', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const clerk: ClerkUserLookup = {
      users: {
        getUser: vi.fn().mockResolvedValue({
          primaryEmailAddressId: null,
          updatedAt: Date.now(),
          firstName: null,
          lastName: null,
          banned: false,
          locked: false,
          emailAddresses: [
            {
              id: 'email_1',
              emailAddress: 'ada@example.test',
              verification: { status: 'verified' },
            },
          ],
        }),
      },
    };

    await syncUserIdentity({ query } as unknown as Pool, 'user_1', clerk);

    expect(query.mock.calls[0]?.[1]?.[1]).toBeNull();
    expect(query.mock.calls[0]?.[1]?.[3]).toBe(false);
  });
});
