export default function NewProjectPage() {
  return (
    <main className="project-form-page">
      <section aria-labelledby="new-project-title">
        <p className="eyebrow">Begin a chapter</p>
        <h1 id="new-project-title">Who is this film for?</h1>
        <p className="dek">
          Start with the person at the heart of the story. You can gather the
          photographs and details next.
        </p>
        <form action="/api/projects" method="post">
          <label>
            Working title
            <input name="title" required maxLength={160} />
          </label>
          <label>
            Their name
            <input name="subjectName" required maxLength={120} />
          </label>
          <label>
            Your name
            <input name="creatorName" required maxLength={120} />
          </label>
          <label>
            Your relationship to them
            <input name="creatorRelationship" required maxLength={120} />
          </label>
          <label>
            What do you hope this gift preserves? <span>(optional)</span>
            <textarea name="giftIntention" maxLength={500} rows={4} />
          </label>
          <button type="submit">Gather the pieces</button>
        </form>
      </section>
    </main>
  );
}
