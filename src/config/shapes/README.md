# Shapes

A shape is what a document looks like: its parts, in order, with a prompt for
each. Several programs require the same shape, so a shape is its own object
rather than a property of whichever fair asked for it first.

**Not a layout engine.** A shape names the parts and says what goes in them.
It says nothing about fonts, margins, or placement, and it must not start to:
the student writes the deliverable in Google Docs or Canva or on a board, and
a template that tries to describe the artifact will be worse than the tool
they are already using.

What a shape gives is guidance at the moment somebody needs it — four boxes
with a prompt each, or eight sections with a word floor and a sentence saying
why the section exists.

**One exception, drawn rather than described.** A `graphic` field is a
picture the page makes from other fields on the same shape (`sources`),
with a Generate button: `graphic: summary` is the class's research graphic
(question, impact, data, users), `graphic: impact` the impact and
feasibility grid. The picture is kept on the document as a PNG, like a
`file`, so the Elder reads it and the PDF prints it. The drawing is in
`src/lib/research-graphics.ts`.
