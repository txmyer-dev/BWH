import Link from 'next/link';

export default function Home() {
  return (
    <main className="landing">
      <header className="masthead">
        <Link className="wordmark" href="/" aria-label="Legacy Studio home">
          Legacy Studio
        </Link>
        <span className="edition">Family films, thoughtfully made</span>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">A living archive</p>
        <h1 id="hero-title">
          Turn a handful of family photographs into a film they can keep.
        </h1>
        <p className="dek">
          Shape scattered photographs and remembered stories into a quiet,
          beautifully paced film for the people who matter most.
        </p>
        <a className="cta" href="#begin">
          Begin a family film <span aria-hidden="true">→</span>
        </a>
      </section>

      <section className="process" id="begin" aria-label="How it works">
        <p>Photographs</p>
        <span aria-hidden="true" />
        <p>Stories</p>
        <span aria-hidden="true" />
        <p>A film to keep</p>
      </section>
    </main>
  );
}
