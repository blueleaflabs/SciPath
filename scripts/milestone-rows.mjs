/**
 * ONE STEP OF A TEMPLATE, AS THE ROW THE DATABASE HOLDS FOR IT (dev-160).
 *
 * The seed wrote `program_milestones` rows from a resolved template; the
 * redate script now writes them too, for a step added to a running class.
 * Two writers of the same row is one function, or it is two facts that
 * can disagree. This is the function. `seed-programs.mjs` and
 * `program-redate.mjs` both call it; nothing else should decide what a
 * step's row looks like.
 */

/* Which deliverable the step asks for, by the id the template uses: the
   first, because that is the one the deadline is named for. Null where a
   step hands nothing over. */
export function deliverableRef(step) {
  const first = (step.deliverables ?? [])[0];
  return first ? (first.ref ?? first.id ?? null) : null;
}

export function kindOf(step) {
  if (step.consequence === 'blocks_experimentation') return 'approval';
  if (step.consequence === 'blocks_registration') return 'registration';
  if (step.consequence === 'blocks_competition') return 'submission';
  if (/judg/i.test(step.name)) return 'judging';

  /* A club's own step is never an event. The club put it in the calendar
     because somebody has to do something, whether or not a deliverable was
     declared for it — "ask a teacher to sponsor" has nothing to hand in and
     is the single most important thing in October. */
  if (step.internal) return 'local';

  /* Nothing to hand in, nothing at stake, and nobody's own step: a day on
     the calendar rather than an obligation. Applications open, results are
     announced. A student counting down to one learns nothing they can act
     on, so the interface skips them when it asks what is next. */
  const nothingDue = (step.deliverables ?? []).length === 0;
  const nothingAtStake = !step.consequence || step.consequence === 'none';
  if (nothingDue && nothingAtStake && !step.repeats) return 'event';

  if ((step.deliverables ?? []).some((d) => (d.ref ?? d.id ?? '').includes('form'))) return 'form';
  return 'submission';
}

/* Where the date came from, in the note, because a deadline derived from a
   phase and one read off a fair's calendar are not the same kind of promise
   and a student should be able to tell. */
export function noteFor(d) {
  return [
    d.source === 'window' && d.window ? `From the ${d.window.from} to ${d.window.to} phase.` : null,
    d.step.note ?? d.step.risk ?? null,
  ].filter(Boolean).join(' ') || null;
}

/**
 * The row for one dated step. `d` is an entry of `datesFor(resolved)`;
 * `index` its position, for a step with no `order` of its own.
 */
export function milestoneRow(d, index, { programId, orgId }) {
  return {
    program_id: programId,
    /* A club's own deadline is scoped to the school; the institution's is
       not, because every school entering that fair shares it. */
    org_id: d.step.internal ? orgId : null,
    name: d.step.name,
    kind: kindOf(d.step),
    due_on: d.date,
    required: d.step.applies_when ? false : true,
    blocks_experimentation: d.step.consequence === 'blocks_experimentation',
    notes: noteFor(d),
    sort_order: Math.round((d.step.order ?? index) * 10),
    /* The layer that contributed the step: the research process, the
       institution, or the school's own club. Tagged during resolution. */
    source: d.step.source ?? (d.step.internal ? 'school' : 'program'),
    phase: d.step.phase ?? null,
    satisfied_by: d.step.id === 'club_sponsor' || d.step.id === 'sponsor' ? 'sponsor' : null,
    deliverable_ref: deliverableRef(d.step),
    /* Whose obligation it is, which step it came from, and for an Elder's
       task what it waits on and what the feedback goes on. */
    owner: d.step.owner === 'staff' ? 'staff' : 'student',
    step_id: d.step.id ?? null,
    requires_step: d.step.owner === 'staff' ? (d.step.requires?.[0] ?? null) : null,
    requires_steps: d.step.requires ?? [],
    feedback_on: d.step.owner === 'staff' ? (d.step.feedback_on ?? null) : null,
  };
}

/** The participation's copy of a program row, as `app.copy_milestones` makes it. */
export function entryCopy(row, programMilestoneId, { participationId, orgId }) {
  return {
    org_id: orgId,
    participation_id: participationId,
    program_milestone_id: programMilestoneId,
    name: row.name,
    kind: row.kind,
    due_on: row.due_on,
    required: row.required,
    blocks_experimentation: row.blocks_experimentation,
    satisfied_by: row.satisfied_by,
    sort_order: row.sort_order,
    source: row.source,
    phase: row.phase,
    owner: row.owner,
    step_id: row.step_id,
    requires_step: row.requires_step,
    requires_steps: row.requires_steps,
    feedback_on: row.feedback_on,
  };
}
