/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** False when the Supabase variables are absent. The archive still builds. */
    configured?: boolean;
    /** Resolved from the hostname on every request. */
    orgSlug?: string;
    org?: unknown;
    session: { id: string; email: string | null } | null;
    /** The public.users row. Null means a session exists but signup has not run. */
    account: {
      id: string;
      org_id: string;
      display_name: string;
      grad_year: number | null;
      population: string;
      status: string;
      affiliation_state: string;
      consent_state: string;
      author_slug: string | null;
    } | null;
    roles: { role: string; scope_id: string | null }[];
    supabase?: unknown;
    runtime?: { env: Record<string, string> };
  }
}
