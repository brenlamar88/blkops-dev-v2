/* Study Library placeholder.

   The full training-document library (from blkops-development) uploads PDFs to
   a private "marketing-training" storage bucket, tracks per-page study events,
   and depends on the pdf-lib package plus the training_documents / study_events
   tables (dev migration 23). That subsystem hasn't been ported yet, so this is
   a stub that keeps the Portfolio page working. Swap it for the real component
   once the storage bucket, migration and pdf-lib dependency are in place. */
export default function StudyLibrary() {
  return (
    <section className="card card-body">
      <h2>Study library</h2>
      <p style={{ color: 'var(--ink-3)' }}>
        The training-document library isn’t enabled on this instance yet. It
        needs the training storage bucket and tables set up before PDFs can be
        uploaded and studied here.
      </p>
    </section>
  )
}
