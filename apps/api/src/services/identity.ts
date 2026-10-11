import { createClerkClient } from '@clerk/backend';
import { Pool } from 'pg';

export interface ClerkUserLookup {
  users: {
    getUser(subject: string): Promise<{
      banned?: boolean;
      locked?: boolean;
      firstName?: string | null;
      lastName?: string | null;
      updatedAt?: number | Date | null;
      primaryEmailAddressId?: string | null;
      emailAddresses: Array<{
        id: string;
        emailAddress: string;
        verification?: { status?: string | null } | null;
      }>;
    }>;
  };
}

function sourceUpdatedAt(value: number | Date | null | undefined): Date | null {
  const date = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

export function createIdentityLookup(secretKey = process.env.CLERK_SECRET_KEY): ClerkUserLookup {
  if (!secretKey)
    throw new Error('CLERK_SECRET_KEY is required for trusted identity synchronization.');
  return createClerkClient({ secretKey });
}

/** Synchronizes only the Clerk Backend API record; JWT email claims are never read. */
export async function syncUserIdentity(
  pool: Pool,
  authSubject: string,
  clerk: ClerkUserLookup = createIdentityLookup(),
): Promise<void> {
  const user = await clerk.users.getUser(authSubject);
  const primary = user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId);
  const email = primary?.emailAddress.trim().toLowerCase() || null;
  const updatedAt = sourceUpdatedAt(user.updatedAt);
  const verified = Boolean(
    email &&
    !user.banned &&
    !user.locked &&
    primary?.verification?.status === 'verified' &&
    updatedAt,
  );
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
  await pool.query('SELECT app.sync_user_identity($1, $2, $3, $4, $5)', [
    authSubject,
    email,
    displayName,
    verified,
    updatedAt,
  ]);
}
