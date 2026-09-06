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
    /** Programs with a private showcase this person may open. */
    showcases: { program_id: string; name: string; short_name: string | null }[];
    /** Cohort programs this advisor runs. */
    classes: { program_id: string; name: string; short_name: string | null }[];
    /** Cohort programs this person is an Elder (officer) in, for the tracker. */
    families: { program_id: string; name: string; short_name: string | null }[];
    /** The reader's own projects and the places each is in, for the tab
     *  bar: one project in one class is two tabs, My project and Notebook. */
    projects: { project_id: string; title: string; places: { participation_id: string; program_id: string; name: string; short_name: string | null; cohort: boolean }[] }[];
    supabase?: unknown;
    runtime?: { env: Record<string, string> };
  }
}
